import AndroidBilling from './billing';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({ getAndroidInstanceClient: jest.fn() }));

function setup(action: string, flags: Record<string, unknown> = {}) {
  const instance = Object.assign(Object.create(AndroidBilling.prototype), {
    parse: async () => ({
      args: { action, package: 'com.example.app' },
      flags: { json: true, id: 'android_test', ...flags },
    }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => 'android_test',
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return instance;
}

beforeEach(() => jest.clearAllMocks());

test.each([
  ['set', {}],
  ['next', {}],
  ['renew', {}],
  ['status', { product: 'pro' }],
  ['reset', { config: 'file.json' }],
])('rejects invalid %s arguments before connecting', async (action, flags) => {
  await expect(setup(action as string, flags as Record<string, unknown>).run()).rejects.toThrow();
  expect(getAndroidInstanceClient).not.toHaveBeenCalled();
});

test('uses the SDK controls and disconnects when a transition fails', async () => {
  const disconnect = jest.fn();
  const transition = jest.fn().mockRejectedValue(new Error('Product is not owned'));
  jest
    .mocked(getAndroidInstanceClient)
    .mockResolvedValue({ client: { billing: { transition } }, disconnect } as any);
  await expect(setup('renew', { product: 'pro' }).run()).rejects.toThrow('Product is not owned');
  expect(transition).toHaveBeenCalledWith('com.example.app', 'pro', 'renew');
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('reports local sandbox state after a control succeeds', async () => {
  const disconnect = jest.fn();
  const state = { environment: 'limrun-local-sandbox', enabled: true };
  const setNextOutcome = jest.fn();
  const status = jest.fn().mockResolvedValue(state);
  jest
    .mocked(getAndroidInstanceClient)
    .mockResolvedValue({ client: { billing: { setNextOutcome, status } }, disconnect } as any);
  const command = setup('next', { outcome: 'pending' });
  await command.run();
  expect(setNextOutcome).toHaveBeenCalledWith('com.example.app', 'pending');
  expect(command.outputJson).toHaveBeenCalledWith(state);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
