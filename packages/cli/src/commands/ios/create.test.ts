import IosCreate from './create';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  registerCreatedInstance: jest.fn(),
}));

function setup(flags: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({
    metadata: { id: 'ios_test' },
    spec: { region: 'eu-north1' },
    status: { state: 'ready' },
  });
  const command = Object.assign(Object.create(IosCreate.prototype), {
    parse: async () => ({ args: {}, flags: { open: false, 'persist-ttl': '72h', ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    consoleStreamUrl: () => 'https://console.example.test/stream/ios_test',
    info: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { iosInstances: { create } } });
  return { command, create };
}

test('--tunnel names the persistent tunnel in the instance spec', async () => {
  const { command, create } = setup({ tunnel: 'staging' });
  await command.run();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ spec: { tunnel: 'staging' } }));
});

test('omits the tunnel without --tunnel', async () => {
  const { command, create } = setup({});
  await command.run();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ spec: {} }));
});
