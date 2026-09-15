import type { GradleSyncOptions } from '@limrun/api';
import GradleSync from './sync';

function setup(flags: Record<string, unknown> = {}, path?: string) {
  const target = { id: 'gradle_euna_test' };
  const sync = jest.fn().mockResolvedValue({ bytesSent: 1024 });
  const command = Object.assign(Object.create(GradleSync.prototype), {
    parse: async () => ({ args: { path }, flags: { watch: false, ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveGradleTargetOrCreate: jest.fn().mockResolvedValue(target),
    resolveGradleClient: jest.fn().mockResolvedValue({ sync }),
    info: jest.fn(),
    output: jest.fn(),
    warn: jest.fn(),
  });
  return { command, sync, target };
}

test('syncs the current directory once on the remembered or created Gradle target', async () => {
  const { command, sync, target } = setup();
  await command.run();
  expect(command.resolveGradleTargetOrCreate).toHaveBeenCalledWith(undefined);
  expect(command.resolveGradleClient).toHaveBeenCalledWith(target);
  expect(sync).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({ watch: false }));
  expect(command.output).not.toHaveBeenCalledWith(expect.stringContaining('Watching'));
});

test('syncs an explicit path and target with filters, cache, and additional files', async () => {
  const { command, sync } = setup(
    {
      id: 'gradle_euna_chosen',
      'basis-cache-dir': './cache',
      ignore: ['^artifacts/', '^logs/'],
      include: ['^generated/'],
      'additional-file': ['/tmp/npmrc=.npmrc'],
    },
    './my-app',
  );
  await command.run();
  expect(command.resolveGradleTargetOrCreate).toHaveBeenCalledWith('gradle_euna_chosen');
  const [path, options] = sync.mock.calls[0] as [string, GradleSyncOptions];
  expect(path).toBe('./my-app');
  expect(options.basisCacheDir).toBe('./cache');
  expect(options.additionalFiles).toEqual([{ localPath: '/tmp/npmrc', remotePath: '.npmrc' }]);
  expect(options.ignore?.('artifacts/app.apk')).toBe(true);
  expect(options.ignore?.('logs/build.log')).toBe(true);
  expect(options.ignore?.('src/Main.kt')).toBe(false);
  expect(options.include?.('generated/Config.kt')).toBe(true);
  options.onSyncComplete?.({ bytesSent: 1024, durationMs: 1000 });
  expect(command.output).toHaveBeenCalledWith('Sync completed in 1s (1.0KB sent).');
});

test.each([{ ignore: ['['] }, { include: ['['] }, { 'additional-file': ['missing-destination'] }])(
  'rejects invalid sync options before creating an instance: %j',
  async (flags) => {
    const { command, sync } = setup(flags);
    await expect(command.run()).rejects.toThrow();
    expect(command.resolveGradleTargetOrCreate).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  },
);

test.each(['SIGINT', 'SIGTERM'] as const)('stops watching cleanly on %s', async (signal) => {
  const { command, sync } = setup({ watch: true });
  const stopWatching = jest.fn().mockResolvedValue(undefined);
  sync.mockResolvedValue({ stopWatching });
  const previousInt = process.listeners('SIGINT');
  const previousTerm = process.listeners('SIGTERM');
  let ready!: () => void;
  const watching = new Promise<void>((resolve) => {
    ready = resolve;
  });
  command.output.mockImplementation((message: string) => {
    if (message.startsWith('Watching')) ready();
  });
  const running = command.run();
  await watching;
  const previous = signal === 'SIGINT' ? previousInt : previousTerm;
  const shutdown = process.listeners(signal).find((listener) => !previous.includes(listener));
  expect(shutdown).toBeDefined();
  shutdown!(signal);
  shutdown!(signal);
  await running;
  expect(stopWatching).toHaveBeenCalledTimes(1);
  expect(process.listeners('SIGINT')).toEqual(previousInt);
  expect(process.listeners('SIGTERM')).toEqual(previousTerm);
});
