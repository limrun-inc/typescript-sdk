import AndroidProxySet from './set';
import AndroidProxyClear from './clear';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getAndroidInstanceClient: jest.fn() }));

function setup(
  command: typeof AndroidProxySet | typeof AndroidProxyClear,
  args: Record<string, string> = {},
  exitCode = 0,
) {
  const client = {
    adbShell: jest.fn().mockResolvedValue({ stdout: '', stderr: 'denied', exitCode, truncated: false }),
  };
  const disconnect = jest.fn();
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ args, flags: { json: true, id: 'android_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => 'android_test',
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return { command: instance, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

test('set writes the global http_proxy setting', async () => {
  const { command, client, disconnect } = setup(AndroidProxySet, { proxy: 'Proxy.Acme.Internal:3128' });
  await command.run();
  expect(client.adbShell).toHaveBeenCalledWith('settings', [
    'put',
    'global',
    'http_proxy',
    'proxy.acme.internal:3128',
  ]);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: 'proxy.acme.internal:3128' });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('set refuses a malformed proxy before connecting', async () => {
  const { command } = setup(AndroidProxySet, { proxy: 'localhost' });
  await expect(command.run()).rejects.toThrow('Invalid proxy localhost.');
  expect(getAndroidInstanceClient).not.toHaveBeenCalled();
});

test('set reports a failed settings command', async () => {
  const { command, disconnect } = setup(AndroidProxySet, { proxy: 'localhost:3128' }, 255);
  await expect(command.run()).rejects.toThrow('denied');
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('clear sets the proxy to :0', async () => {
  const { command, client } = setup(AndroidProxyClear);
  await command.run();
  expect(client.adbShell).toHaveBeenCalledWith('settings', ['put', 'global', 'http_proxy', ':0']);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: null });
});
