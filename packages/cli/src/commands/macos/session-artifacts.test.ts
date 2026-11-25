import MacosRecordings from './recordings';
import MacosAppLogs from './app-logs';
import MacosEvents from './events';
import MacosPerfCaptures from './perf-captures';

const artifact = {
  id: 'art_1',
  kind: 'recording',
  createdAt: '2026-11-26T10:00:00Z',
  expiresAt: '2026-11-29T10:00:00Z',
  sizeBytes: 1024,
  downloadUrl: 'https://storage.example/art_1',
};

test.each([
  [MacosRecordings, 'listRecordings'],
  [MacosAppLogs, 'listAppLogs'],
  [MacosEvents, 'listEvents'],
  [MacosPerfCaptures, 'listPerformanceCaptures'],
] as const)('%p lists with %s for the resolved instance', async (Cmd, method) => {
  const list = jest.fn().mockResolvedValue([artifact]);
  const outputJson = jest.fn();
  const command = Object.assign(Object.create(Cmd.prototype), {
    parse: async () => ({ args: {}, flags: { json: true, id: 'macos_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosTarget: (id: string) => ({ id }),
    outputJson,
  });
  Object.defineProperty(command, 'client', { value: { macosInstances: { [method]: list } } });
  await command.run();
  expect(list).toHaveBeenCalledWith('macos_test');
  expect(outputJson).toHaveBeenCalledWith([artifact]);
});
