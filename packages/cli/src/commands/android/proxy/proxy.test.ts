import AndroidProxySet from './set';
import AndroidProxyClear from './clear';
import { runAndroidAdbShell } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ runAndroidAdbShell: jest.fn() }));

function setup(
  command: typeof AndroidProxySet | typeof AndroidProxyClear,
  args: Record<string, string> = {},
) {
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ args, flags: { json: true, id: 'android_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => 'android_test',
    outputJson: jest.fn(),
    error: (message: string, options?: { exit?: number }): never => {
      throw Object.assign(new Error(message), { exit: options?.exit });
    },
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return instance;
}

function shellResult(exitCode: number) {
  return { stdout: '', stderr: exitCode === 0 ? '' : 'denied', exitCode, truncated: false };
}

beforeEach(() => jest.clearAllMocks());

test('set writes the global http_proxy setting', async () => {
  jest.mocked(runAndroidAdbShell).mockResolvedValue(shellResult(0));
  const command = setup(AndroidProxySet, { proxy: 'Proxy.Acme.Internal:3128' });
  await command.run();
  expect(runAndroidAdbShell).toHaveBeenCalledWith({}, 'android_test', 'settings', [
    'put',
    'global',
    'http_proxy',
    'proxy.acme.internal:3128',
  ]);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: 'proxy.acme.internal:3128' });
});

test('set refuses a malformed proxy before connecting', async () => {
  const command = setup(AndroidProxySet, { proxy: 'localhost' });
  await expect(command.run()).rejects.toThrow('Invalid proxy localhost.');
  expect(runAndroidAdbShell).not.toHaveBeenCalled();
});

test('set reports a failed settings command with its exit code', async () => {
  jest.mocked(runAndroidAdbShell).mockResolvedValue(shellResult(255));
  const command = setup(AndroidProxySet, { proxy: 'localhost:3128' });
  await expect(command.run()).rejects.toMatchObject({ message: 'denied', exit: 255 });
});

test('clear sets the proxy to :0', async () => {
  jest.mocked(runAndroidAdbShell).mockResolvedValue(shellResult(0));
  const command = setup(AndroidProxyClear);
  await command.run();
  expect(runAndroidAdbShell).toHaveBeenCalledWith({}, 'android_test', 'settings', [
    'put',
    'global',
    'http_proxy',
    ':0',
  ]);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: null });
});

test('clear reports a failed settings command with its exit code', async () => {
  jest.mocked(runAndroidAdbShell).mockResolvedValue(shellResult(1));
  const command = setup(AndroidProxyClear);
  await expect(command.run()).rejects.toMatchObject({ message: 'denied', exit: 1 });
});
