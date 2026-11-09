import IosBlocklistAdd from './add';
import IosBlocklistRemove from './remove';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getIosInstanceClient: jest.fn() }));

function setup(
  command: typeof IosBlocklistAdd | typeof IosBlocklistRemove,
  argv: string[],
  current: string[],
) {
  const client = {
    getBlockedDomains: jest.fn().mockResolvedValue(current),
    setBlockedDomains: jest.fn().mockImplementation(async (domains: string[]) => domains),
  };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ argv, flags: { json: true, id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(instance, 'client', { value: {} });
  return { instance, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

test('add appends to the blocklist the instance holds', async () => {
  const { instance, client, disconnect } = setup(IosBlocklistAdd, ['*.facebook.com'], ['facebook.com']);
  await instance.run();
  expect(client.setBlockedDomains).toHaveBeenCalledWith(['facebook.com', '*.facebook.com']);
  expect(instance.outputJson).toHaveBeenCalledWith({
    ok: true,
    instanceId: 'ios_test',
    domains: ['facebook.com', '*.facebook.com'],
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('remove drops only the named entries', async () => {
  const { instance, client } = setup(
    IosBlocklistRemove,
    ['facebook.com'],
    ['facebook.com', '*.facebook.com'],
  );
  await instance.run();
  expect(client.setBlockedDomains).toHaveBeenCalledWith(['*.facebook.com']);
});

test('add refuses an empty request before connecting', async () => {
  const { instance } = setup(IosBlocklistAdd, [], []);
  await expect(instance.run()).rejects.toThrow('Name at least one domain to block.');
  expect(getIosInstanceClient).not.toHaveBeenCalled();
});
