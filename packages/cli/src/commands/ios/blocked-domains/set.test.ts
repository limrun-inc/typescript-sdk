import IosBlockedDomainsSet from './set';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getIosInstanceClient: jest.fn() }));

function setup(argv: string[]) {
  const client = { setBlockedDomains: jest.fn().mockImplementation(async (domains: string[]) => domains) };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(IosBlockedDomainsSet.prototype), {
    parse: async () => ({ argv, flags: { json: true, id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
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
    instanceId: 'ios_test',
    domains: ['facebook.com', '*.facebook.com'],
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('naming no domains unblocks everything', async () => {
  const { command, client } = setup([]);
  await command.run();
  expect(client.setBlockedDomains).toHaveBeenCalledWith([]);
  expect(command.outputJson).toHaveBeenCalledWith({ ok: true, instanceId: 'ios_test', domains: [] });
});
