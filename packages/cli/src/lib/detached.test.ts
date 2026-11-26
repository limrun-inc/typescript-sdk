import fs from 'fs';
import os from 'os';
import path from 'path';
import { startDetached } from './detached';

// startDetached runs process.argv[1] as the CLI, so each test points it at a script of its own.
let dir: string;
let realScript: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-detached-'));
  jest.spyOn(os, 'homedir').mockReturnValue(dir);
  realScript = process.argv[1];
});
afterEach(() => {
  process.argv[1] = realScript!;
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function cli(source: string): void {
  const script = path.join(dir, 'cli.js');
  fs.writeFileSync(script, source);
  process.argv[1] = script;
}

test('returns the ready JSON once the background process prints it, and leaves it running', async () => {
  cli(`
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }, null, 2) + '\\n');
    setTimeout(() => {}, 60_000);
  `);
  const started = await startDetached({ name: 'test-ready', args: ['ios', 'forward', '8100'] });
  try {
    expect(started.ready).toEqual({ args: ['ios', 'forward', '8100', '--no-detach', '--json'] });
    expect(() => process.kill(started.pid, 0)).not.toThrow();
    expect(started.logPath).toBe(path.join(dir, '.lim', 'detached', 'test-ready.log'));
  } finally {
    process.kill(started.pid, 'SIGKILL');
  }
});

test('fails with the end of the log when the background process exits first', async () => {
  cli(`
    process.stderr.write('Error: the instance is gone\\n');
    process.exit(2);
  `);
  await expect(startDetached({ name: 'test-exit', args: ['android', 'connect'] })).rejects.toThrow(
    /exited during startup \(code 2\)[\s\S]*the instance is gone/,
  );
});

test('stops a background process that never becomes ready', async () => {
  cli(`setTimeout(() => {}, 60_000);`);
  await expect(
    startDetached({ name: 'test-slow', args: ['ios', 'reverse'], timeoutMs: 500 }),
  ).rejects.toThrow(/did not become ready in time/);
});
