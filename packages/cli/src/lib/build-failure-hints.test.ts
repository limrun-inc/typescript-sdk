import { EventEmitter } from 'events';
import type { ExecChildProcess } from '@limrun/api/exec-client';
import { BuildFailureHints, type BuildPlatform } from './build-failure-hints';
import { streamBuildCommand } from './build-command-helpers';
import fixtures from './build-failure-hints.fixtures.json';

function match(diagnostic: string, platform: BuildPlatform = 'gradle', exitCode = 1): string[] {
  const collector = new BuildFailureHints(platform);
  collector.addEvent({ type: 'stderr', data: diagnostic });
  return collector.getHints({ exitCode });
}

test.each(fixtures.capabilities)('%s suggests a CLI capability', (_name, diagnostic, expected) => {
  const hints = match(diagnostic!);
  expect(hints.join('\n')).toContain(expected);
  for (const hint of hints) {
    expect(hint).toMatch(/You can|you can/);
    expect(hint).not.toContain('lim secret write');
    if (hint.includes('--file-from-secret')) {
      expect(hint).toContain('lim secret create <name> --file');
      expect(hint).toContain('=<name>');
    }
    if (hint.includes('--env-from-secret')) expect(hint).toContain('lim secret create <name> --stdin');
  }
});

test.each(fixtures.noHints)('does not speculate for %s', (diagnostic) => {
  expect(match(diagnostic)).toEqual([]);
});

test('uses only final-command output, not commands or earlier warnings', () => {
  const collector = new BuildFailureHints('gradle');
  collector.addEvent({ type: 'stderr', data: 'ERR_PNPM_UNSUPPORTED_ENGINE' });
  collector.addEvent({ type: 'command', data: 'echo ERR_PNPM_FETCH_403' });
  collector.addEvent({ type: 'stderr', data: 'exit status 1' });
  expect(collector.getHints({ exitCode: 1 })).toEqual([]);
});

test('bounds retained output and individual diagnostic lines', () => {
  const collector = new BuildFailureHints('gradle');
  collector.addEvent({ type: 'stderr', data: 'ERR_PNPM_UNSUPPORTED_ENGINE' });
  collector.addEvent({ type: 'stdout', data: 'x'.repeat((1 << 20) + 1) });
  expect(collector.getHints({ exitCode: 1 })).toEqual([]);
  collector.addEvent({ type: 'stderr', data: 'local.properties '.repeat(100_000) });
  expect(collector.getHints({ exitCode: 1 })).toEqual([]);
  collector.addEvent({ type: 'stderr', data: 'ERR_PNPM_MISSING_TARBALL_INTEGRITY' });
  expect(collector.getHints({ exitCode: 1 }).join()).toContain('pnpm@<version>');
});

test('deduplicates, caps hints, and never interpolates customer output', () => {
  const hints = match(
    "ERR_PNPM_UNSUPPORTED_ENGINE\nERR_PNPM_UNSUPPORTED_ENGINE\nENOENT: '/private/$(echo token)/google-services.json'",
    'xcode',
  );
  expect(hints).toHaveLength(3);
  expect(new Set(hints).size).toBe(3);
  expect(hints.join()).not.toMatch(/token|lim gradle/);
});

test.each([
  { exitCode: 0 },
  { exitCode: -1 },
  {},
  { exitCode: 1, status: 'RUNNING' },
  { exitCode: 1, status: 'CANCELLED' },
  { exitCode: 124, timedOut: true },
])('does not diagnose an unsuccessful-looking log without confirmed failure: %j', (result) => {
  const collector = new BuildFailureHints('gradle');
  collector.addEvent({ type: 'stderr', data: 'ERR_PNPM_UNSUPPORTED_ENGINE' });
  expect(collector.getHints(result)).toEqual([]);
});

test('timeout hint requires the server deadline message and matching exit code', () => {
  expect(match('command timed out after 10m0s', 'gradle', 124).join()).toContain('--timeout');
  expect(match('command timed out after 10m0s', 'gradle')).toEqual([]);
  expect(match('Gradle connection timed out', 'gradle', 124)).toEqual([]);
});

test('does not suggest Gradle-only flags on Xcode', () => {
  const hints = match(
    "gradlew wrapper not found or not executable at the Gradle root\nKeystore file '/workspace/key.jks' not found",
    'xcode',
  ).join();
  expect(hints).toContain('--include');
  expect(hints).not.toMatch(/--project-path|--keystore/);
  expect(match('Failed to find Build Tools revision 35.0.0', 'xcode')).toEqual([]);
  expect(match('capacitor.config.json: no such file', 'xcode').join()).toContain('lim xcode run');
});

test.each([
  ['ERR_PNPM_MISSING_TARBALL_INTEGRITY', true],
  ['ERR_PNPM_UNSUPPORTED_ENGINE', true],
  ['ERR_PNPM_NO_MATCHING_VERSION pnpm@10.99.0', true],
  ['cordova.variables.gradle does not exist', true],
  ['capacitor.config.json: no such file', true],
  ['python3_bin_reldir.txt not found', true],
  ["Could not find an existing 'expo' binary to run", true],
  ['ERR_PNPM_FETCH_401', false],
  ['File google-services.json is missing', false],
  ['error: An organization ID or slug is required', false],
  ['java.lang.OutOfMemoryError: Java heap space', false],
] as const)('snapshot guidance for %s', (diagnostic, snapshot) => {
  expect(match(diagnostic, 'gradle').join()).not.toContain('--snapshot-key');
  expect(match(diagnostic, 'xcode').join().includes('--snapshot-key')).toBe(snapshot);
});

test('does not duplicate hints already emitted by an older daemon', () => {
  const diagnostic = 'ERR_PNPM_MISSING_TARBALL_INTEGRITY';
  const hint = match(diagnostic)[0];
  expect(match(`${diagnostic}\nHint: ${hint}`)).toEqual([]);
});

test.each([false, true])(
  'run command renders CLI hints with JSON=%s without modifying SDK data',
  async (json) => {
    const raw = 'ERR_PNPM_MISSING_TARBALL_INTEGRITY';
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const command = new EventEmitter();
    const sdkResult = { exitCode: 1, execId: 'run-1', status: 'FAILED' as const };
    const originalOutput: string[] = [];
    stderr.on('data', (line) => originalOutput.push(line));
    const proc = Object.assign(
      new Promise((resolve) =>
        queueMicrotask(() => {
          command.emit('data', 'pnpm install');
          stderr.emit('data', raw);
          resolve(sdkResult);
        }),
      ),
      { stdout, stderr, command },
    ) as unknown as ExecChildProcess;
    const outputJson = jest.fn();
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = jest.fn((message: string): never => {
      throw new Error(message);
    });
    try {
      await expect(
        streamBuildCommand(proc, 'gradle', error, 'Command failed', json ? outputJson : undefined),
      ).rejects.toThrow();
      expect(originalOutput).toEqual([raw]);
      expect(sdkResult).toEqual({ exitCode: 1, execId: 'run-1', status: 'FAILED' });
      if (json) {
        expect(outputJson).toHaveBeenCalledWith({
          ...sdkResult,
          stdout: '',
          stderr: raw + '\n',
          hints: [expect.stringContaining('pnpm@<version>')],
        });
        expect(write).not.toHaveBeenCalled();
      } else {
        expect(write).toHaveBeenCalledWith(raw + '\n');
        expect(write).toHaveBeenCalledWith(expect.stringContaining('Hint: You can'));
      }
    } finally {
      write.mockRestore();
    }
  },
);

test('older daemon hints count toward the three-hint limit', () => {
  const diagnostic =
    'ERR_PNPM_UNSUPPORTED_ENGINE\nFile google-services.json is missing\nOutOfMemoryError: Java heap space';
  const hints = match(diagnostic);
  expect(hints).toHaveLength(3);
  expect(match(diagnostic + '\n' + hints.map((hint) => 'Hint: ' + hint).join('\n'))).toEqual([]);
});
