import IosElementTree from './element-tree';
import {
  ensureDaemonSession,
  getIosInstanceClient,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({
  ensureDaemonSession: jest.fn(),
  getIosInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

const tree = [{ AXUniqueId: 'nav.add', type: 'Button' }];

function command(flags: Record<string, unknown>) {
  const instance = Object.assign(Object.create(IosElementTree.prototype), {
    parse: async () => ({ flags: { 'visible-only': false, json: true, id: 'ios_test', ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputJson: jest.fn(),
    warn: jest.fn(),
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return instance;
}

test.each([true, false])('forwards the reader and idle wait with daemon=%s', async (daemon) => {
  const read = { tree, keyboard: null, idle: true };
  const client = { readElementTree: jest.fn().mockResolvedValue(read) };
  const disconnect = jest.fn();
  jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  jest.mocked(sendSessionCommand).mockResolvedValue(read);

  const run = command({ source: 'xcuitest', 'wait-for-idle-timeout-ms': 2000 });
  await run.run();

  const options = { visibleOnly: false, source: 'xcuitest', waitForIdleTimeoutMs: 2000 };
  if (daemon) {
    expect(sendSessionCommand).toHaveBeenCalledWith('ios_test', 'read-element-tree', [options], 32_000);
  } else {
    expect(client.readElementTree).toHaveBeenCalledWith(undefined, options);
    expect(disconnect).toHaveBeenCalledTimes(1);
  }
  // The JSON output stays the bare tree, as before these flags.
  expect(run.outputJson).toHaveBeenCalledWith(tree);
  expect(run.warn).not.toHaveBeenCalled();
});

test('warns on stderr when the screen did not settle', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  jest.mocked(sendSessionCommand).mockResolvedValue({ tree, keyboard: null, idle: false });

  const run = command({ 'wait-for-idle-timeout-ms': 500 });
  await run.run();

  expect(run.warn).toHaveBeenCalledWith(expect.stringContaining('still changing after 500 ms'));
  expect(run.outputJson).toHaveBeenCalledWith(tree);
});

test('falls back to the bare tree on a daemon from an older CLI', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  jest
    .mocked(sendSessionCommand)
    .mockRejectedValueOnce(new Error('Unknown command: read-element-tree'))
    .mockResolvedValueOnce(tree);

  const run = command({});
  await run.run();

  expect(sendSessionCommand).toHaveBeenLastCalledWith(
    'ios_test',
    'element-tree',
    [{ visibleOnly: false }],
    30_000,
  );
  expect(run.outputJson).toHaveBeenCalledWith(tree);
});
