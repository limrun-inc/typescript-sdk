import MacosAppLog from './app-log';

type Handlers = { onEntry: (line: string) => void; onError?: (error: Error) => void };

function setup(flags: Record<string, unknown>) {
  let handlers!: Handlers;
  const stop = jest.fn();
  let streaming!: () => void;
  const started = new Promise<void>((resolve) => (streaming = resolve));
  const client = {
    appLogTail: jest.fn().mockResolvedValue('line one\nline two'),
    streamAppLog: jest.fn((_bundleId: string, h: Handlers) => {
      handlers = h;
      streaming();
      return stop;
    }),
  };
  const outputResult = jest.fn();
  const outputEvent = jest.fn();
  const command = Object.assign(Object.create(MacosAppLog.prototype), {
    parse: async () => ({ args: { bundleId: 'com.example.app' }, flags: { tail: 100, ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient: async () => ({ id: 'macos_test', client }),
    outputResult,
    outputEvent,
  });
  return { command, client, stop, started, outputResult, outputEvent, handlers: () => handlers };
}

test('prints the last lines of the app log', async () => {
  const { command, client, outputResult } = setup({ tail: 50 });
  await command.run();
  expect(client.appLogTail).toHaveBeenCalledWith('com.example.app', 50);
  expect(outputResult).toHaveBeenCalledWith({ stdout: 'line one\nline two' }, 'line one\nline two');
});

test('--follow streams lines until interrupted', async () => {
  const { command, client, stop, started, outputEvent, handlers } = setup({ follow: true, json: true });
  const running = command.run();
  await started;
  handlers().onEntry('hello');
  process.emit('SIGINT');
  await running;
  expect(client.streamAppLog).toHaveBeenCalledWith('com.example.app', expect.any(Object));
  expect(outputEvent).toHaveBeenCalledWith({ line: 'hello' });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(0);
});

test('--follow fails when the stream breaks', async () => {
  const { command, stop, started, handlers } = setup({ follow: true });
  const running = command.run();
  await started;
  handlers().onError?.(new Error('the app log stream ended'));
  await expect(running).rejects.toThrow('the app log stream ended');
  expect(stop).toHaveBeenCalledTimes(1);
});
