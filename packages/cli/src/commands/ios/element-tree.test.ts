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

test.each([true, false])('forwards the selected reader with daemon=%s', async (daemon) => {
  const tree = [{ AXUniqueId: 'test-only-view' }];
  const client = { elementTree: jest.fn().mockResolvedValue(tree) };
  const disconnect = jest.fn();
  jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  jest.mocked(sendSessionCommand).mockResolvedValue(tree);
  const command = Object.assign(Object.create(IosElementTree.prototype), {
    parse: async () => ({ flags: { source: 'xcuitest', json: true, id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputJson: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  await command.run();
  if (daemon) {
    expect(sendSessionCommand).toHaveBeenCalledWith('ios_test', 'element-tree', [{ source: 'xcuitest' }]);
  } else {
    expect(client.elementTree).toHaveBeenCalledWith(undefined, { source: 'xcuitest' });
    expect(disconnect).toHaveBeenCalledTimes(1);
  }
  expect(command.outputJson).toHaveBeenCalledWith(tree);
});
