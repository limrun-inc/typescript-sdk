import IosProxySet from './set';
import IosProxyClear from './clear';
import { runIosSimctl } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ runIosSimctl: jest.fn() }));

function setup(command: typeof IosProxySet | typeof IosProxyClear, args: Record<string, string> = {}) {
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ args, flags: { json: true, id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => 'ios_test',
    outputJson: jest.fn(),
    error: (message: string, options?: { exit?: number }): never => {
      throw Object.assign(new Error(message), { exit: options?.exit });
    },
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return instance;
}

beforeEach(() => jest.clearAllMocks());

test('set runs the proxy tool with the parsed host and port', async () => {
  jest.mocked(runIosSimctl).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  const command = setup(IosProxySet, { proxy: 'Proxy.Acme.Internal:3128' });
  await command.run();
  expect(runIosSimctl).toHaveBeenCalledWith({}, 'ios_test', [
    'spawn',
    'booted',
    'limproxy',
    'set',
    'proxy.acme.internal',
    '3128',
  ]);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: 'proxy.acme.internal:3128' });
});

test('set refuses a malformed proxy before connecting', async () => {
  const command = setup(IosProxySet, { proxy: '[::1]:3128' });
  await expect(command.run()).rejects.toThrow('Invalid proxy [::1]:3128.');
  expect(runIosSimctl).not.toHaveBeenCalled();
});

test('set explains an instance without the proxy tool', async () => {
  jest.mocked(runIosSimctl).mockResolvedValue({
    code: 1,
    stdout: '',
    stderr:
      'spawn supports only: spawn <device> defaults read|write|delete ..., spawn <device> notifyutil -p|-s|-g ...',
  });
  const command = setup(IosProxySet, { proxy: 'localhost:3128' });
  await expect(command.run()).rejects.toThrow('This instance does not support lim ios proxy yet.');
});

test('clear exits with the tool exit code and message', async () => {
  jest
    .mocked(runIosSimctl)
    .mockResolvedValue({ code: 70, stdout: '', stderr: 'limproxy: restore proxy failed\n' });
  const command = setup(IosProxyClear);
  await expect(command.run()).rejects.toMatchObject({ message: 'limproxy: restore proxy failed', exit: 70 });
});

test('clear runs the proxy tool', async () => {
  jest.mocked(runIosSimctl).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  const command = setup(IosProxyClear);
  await command.run();
  expect(runIosSimctl).toHaveBeenCalledWith({}, 'ios_test', ['spawn', 'booted', 'limproxy', 'clear']);
  expect(command.outputJson).toHaveBeenCalledWith({ proxy: null });
});
