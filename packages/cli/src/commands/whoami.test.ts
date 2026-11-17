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

test('shows server-reported permissions only when requested', async () => {
  for (const permissions of [false, true]) {
    const { command, get } = setup(identity, { permissions });
    await command.run();
    expect(get).toHaveBeenCalledWith('/v1/whoami');
    const output = command.output.mock.calls.flat().join('\n');
    expect(output).toContain('Organization: org_test (Test)');
    expect(output.includes('asset:name/builds/*:all')).toBe(permissions);
    expect(output.includes('remoteexecution:*:all')).toBe(permissions);
  }
});

test('JSON output includes permissions only with --permissions', async () => {
  for (const permissions of [false, true]) {
    const { command } = setup(identity, { permissions, json: true });
    await command.run();
    expect(command.output).not.toHaveBeenCalled();
    const result = command.outputJson.mock.calls[0][0];
    expect(result.organization.id).toBe('org_test');
    expect(result.permissions).toEqual(permissions ? identity.permissions : undefined);
  }
});

test('reports empty grants without inventing wildcard access', async () => {
  const { command } = setup({ ...identity, permissions: [], scopes: ['*:*:all'] }, { permissions: true });
  await command.run();
  expect(command.output).toHaveBeenCalledWith('Permissions:\n  None');
});

test('user memberships keep permissions associated with their organization', async () => {
  const memberships = [
    { organizationId: 'org_one', role: 'admin', permissions: ['*:*:all'] },
    { organizationId: 'org_two', role: 'viewer', permissions: ['ios:*:read'] },
  ];
  const { command } = setup(
    { type: 'user', user: { email: 'test@example.com' }, memberships },
    {
      permissions: true,
      json: true,
    },
  );
  await command.run();
  expect(command.outputJson.mock.calls[0][0].memberships).toEqual(memberships);
});
