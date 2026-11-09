import AndroidBlockedDomainsSet from './set';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getAndroidInstanceClient: jest.fn() }));

function setup(argv: string[]) {
  const client = { setBlockedDomains: jest.fn().mockImplementation(async (domains: string[]) => domains) };
  const disconnect = jest.fn();
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(AndroidBlockedDomainsSet.prototype), {
    parse: async () => ({ argv, flags: { json: true, id: 'android_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => ({ id: 'android_test' }),
    outputJson: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

test('replaces the blocked domains with the ones named', async () => {
  const { command, client, disconnect } = setup(['facebook.com', '*.facebook.com']);
  await command.run();
  expect(client.setBlockedDomains).toHaveBeenCalledWith(['facebook.com', '*.facebook.com']);
  expect(command.outputJson).toHaveBeenCalledWith({
    ok: true,
    instanceId: 'android_test',
    domains: ['facebook.com', '*.facebook.com'],
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('naming no domains unblocks everything', async () => {
  const { command, client } = setup([]);
  await command.run();
  expect(client.setBlockedDomains).toHaveBeenCalledWith([]);
  expect(command.outputJson).toHaveBeenCalledWith({ ok: true, instanceId: 'android_test', domains: [] });
});
