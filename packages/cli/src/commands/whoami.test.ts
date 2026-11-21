import Whoami from './whoami';

function setup(body: object, flags: Record<string, unknown> = {}) {
  const get = jest.fn().mockResolvedValue(body);
  const command = Object.assign(Object.create(Whoami.prototype), {
    parse: async () => ({ flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    output: jest.fn(),
    outputJson: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { get } });
  return { command, get };
}

const identity = {
  type: 'organization',
  organization: { id: 'org_test', displayName: 'Test' },
  permissions: ['asset:name/builds/*:all', 'remoteexecution:*:all'],
};

test('prints identity and server-reported permissions as JSON by default', async () => {
  const { command, get } = setup({
    ...identity,
    organization: { ...identity.organization, creditBalance: '123', stripeCustomerId: 'cus_example' },
  });
  await command.run();
  expect(get).toHaveBeenCalledWith('/v1/whoami');
  expect(command.output).not.toHaveBeenCalled();
  expect(command.outputJson).toHaveBeenCalledWith(identity);
  expect(Whoami.flags.json.default).toBe(true);
});

test('explicit --json produces the same output', async () => {
  const { command } = setup(identity, { json: true });
  await command.run();
  expect(command.outputJson).toHaveBeenCalledWith(identity);
});

test('reports empty grants without inventing wildcard access', async () => {
  const { command } = setup({ ...identity, permissions: [], scopes: ['*:*:all'] });
  await command.run();
  expect(command.outputJson.mock.calls[0][0].permissions).toEqual([]);
});

test('user memberships keep permissions associated with their organization', async () => {
  const memberships = [
    { organizationId: 'org_one', role: 'admin', permissions: ['*:*:all'] },
    { organizationId: 'org_two', role: 'viewer', permissions: ['ios:*:read'] },
  ];
  const { command } = setup(
    { type: 'user', user: { email: 'test@example.com' }, memberships },
    {
      json: true,
    },
  );
  await command.run();
  expect(command.outputJson.mock.calls[0][0].memberships).toEqual(memberships);
});
