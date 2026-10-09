import IosLaunchApp from './launch-app';
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

function setup(env = ['FEATURE=a=b', 'EMPTY=']) {
  const target = { id: 'ios_test', type: 'ios' };
  const client = { launchApp: jest.fn().mockResolvedValue(undefined) };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(IosLaunchApp.prototype), {
    parse: async () => ({ args: { bundleId: 'com.example.app' }, flags: { detach: true, env } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => target,
    log: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect, target };
}

beforeEach(() => jest.clearAllMocks());

test('detached env launches use the normal daemon machinery', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  const { command, target } = setup();
  await command.run();
  expect(ensureDaemonSession).toHaveBeenCalledWith(target);
  expect(sendSessionCommand).toHaveBeenCalledWith('ios_test', 'launch-app', [
    'com.example.app',
    { mode: 'RelaunchIfRunning', env: { FEATURE: 'a=b', EMPTY: '' } },
  ]);
  expect(getIosInstanceClient).not.toHaveBeenCalled();
});

test('direct fallback carries the same env and disconnects', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(false);
  const { command, client, disconnect } = setup();
  await command.run();
  expect(client.launchApp).toHaveBeenCalledWith('com.example.app', {
    mode: 'RelaunchIfRunning',
    env: { FEATURE: 'a=b', EMPTY: '' },
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(sendSessionCommand).not.toHaveBeenCalled();
});

test('reserved env fails before opening either connection', async () => {
  const { command } = setup(['DYLD_LIBRARY_PATH=/tmp']);
  await expect(command.run()).rejects.toThrow('reserved');
  expect(ensureDaemonSession).not.toHaveBeenCalled();
  expect(getIosInstanceClient).not.toHaveBeenCalled();
});
