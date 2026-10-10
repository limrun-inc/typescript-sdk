import TunnelCreate from './create';
import TunnelDelete from './delete';
import TunnelList from './list';
import TunnelRotate from './rotate';
import TunnelUpdate from './update';
import {
  createTunnel,
  deleteTunnel,
  findTunnel,
  listTunnels,
  rotateTunnelToken,
  tunnelOrganization,
  updateTunnelSelectors,
  type PersistentTunnel,
} from '../../lib/backend';

jest.mock('../../lib/backend', () => ({
  tunnelOrganization: jest.fn(async () => 'org_1'),
  listTunnels: jest.fn(),
  findTunnel: jest.fn(),
  createTunnel: jest.fn(),
  updateTunnelSelectors: jest.fn(),
  rotateTunnelToken: jest.fn(),
  deleteTunnel: jest.fn(async () => {}),
}));

const staging: PersistentTunnel = {
  id: 'tunnel_1',
  name: 'staging',
  ephemeral: false,
  online: true,
  selectors: ['localhost:3000', '*.internal.example.com'],
  hostname: 'build-runner-7',
  tokenExpiresAt: '2027-10-10T12:00:00Z',
  instances: [{ id: 'ios_1', platform: 'ios', state: 'ready' }],
};
const issued = { token: 'lim_st_issued', expiresAt: '2027-10-10T12:00:00Z' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(tunnelOrganization).mockResolvedValue('org_1');
});

/** Runs a tunnel command with parsed args and flags, capturing what it prints. */
function setup(
  Command: { prototype: object },
  args: Record<string, unknown>,
  flags: Record<string, unknown> = {},
): { command: { run: () => Promise<void> }; output: jest.Mock; table: jest.Mock; json: jest.Mock } {
  const output = jest.fn();
  const table = jest.fn();
  const json = jest.fn();
  const command = Object.assign(Object.create(Command.prototype), {
    parse: async () => ({ args, flags: { json: false, quiet: false, ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    output,
    outputTable: table,
    outputJson: json,
    error: (message: string) => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', { value: { apiKey: 'lim_admin' } });
  return { command, output, table, json };
}

describe('tunnel create', () => {
  test('creates the tunnel and prints the connector command with its token', async () => {
    jest.mocked(createTunnel).mockResolvedValue({ tunnel: staging, token: issued });
    const { command, output } = setup(
      TunnelCreate,
      { name: 'staging' },
      { selector: ['localhost:3000', '*.internal.example.com'], 'expiration-months': 3 },
    );
    await command.run();

    expect(createTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', {
      name: 'staging',
      selectors: ['localhost:3000', '*.internal.example.com'],
      expirationMonths: 3,
    });
    expect(output.mock.calls[0]![0]).toContain('  lim tunnel run --token lim_st_issued');
    expect(output.mock.calls[0]![0]).toContain('shown only once');
  });

  test('prints only the token with --quiet, for scripts', async () => {
    jest.mocked(createTunnel).mockResolvedValue({ tunnel: staging, token: issued });
    const { command, output } = setup(
      TunnelCreate,
      { name: 'staging' },
      { selector: ['localhost:3000'], 'expiration-months': 12, quiet: true },
    );
    await command.run();
    expect(output).toHaveBeenCalledWith('lim_st_issued');
  });

  test('refuses an invalid selector before calling Limrun', async () => {
    const { command } = setup(TunnelCreate, { name: 'staging' }, { selector: ['localhost:http'] });
    await expect(command.run()).rejects.toThrow();
    expect(createTunnel).not.toHaveBeenCalled();
  });
});

describe('tunnel list', () => {
  test('shows each tunnel with its status, connector, selectors, token expiry and instance count', async () => {
    jest.mocked(listTunnels).mockResolvedValue([
      staging,
      {
        ...staging,
        id: 'tunnel_2',
        name: 'scratch',
        ephemeral: true,
        online: false,
        hostname: undefined,
        tokenExpiresAt: undefined,
        instances: [],
      },
    ]);
    const { command, table } = setup(TunnelList, {});
    await command.run();
    expect(table).toHaveBeenCalledWith(
      ['Name', 'ID', 'Status', 'Connector', 'Selectors', 'Token expires', 'Instances'],
      [
        [
          'staging',
          'tunnel_1',
          'online',
          'build-runner-7',
          'localhost:3000 *.internal.example.com',
          '2027-10-10',
          '1',
        ],
        ['scratch (quick)', 'tunnel_2', 'offline', '', 'localhost:3000 *.internal.example.com', 'none', '0'],
      ],
    );
  });
});

describe('tunnel update, rotate and delete', () => {
  test('replace the selectors of the tunnel they name', async () => {
    jest.mocked(findTunnel).mockResolvedValue(staging);
    jest.mocked(updateTunnelSelectors).mockResolvedValue(staging);
    const { command, output } = setup(TunnelUpdate, { name: 'staging' }, { selector: ['localhost:4000'] });
    await command.run();
    expect(updateTunnelSelectors).toHaveBeenCalledWith(expect.anything(), 'org_1', staging, [
      'localhost:4000',
    ]);
    expect(output.mock.calls[0]![0]).toContain('restart the connector');
  });

  test('rotate the token and print the new connector command', async () => {
    jest.mocked(findTunnel).mockResolvedValue(staging);
    jest.mocked(rotateTunnelToken).mockResolvedValue(issued);
    const { command, output } = setup(TunnelRotate, { name: 'staging' }, { 'expiration-months': 12 });
    await command.run();
    expect(rotateTunnelToken).toHaveBeenCalledWith(expect.anything(), 'org_1', staging, 12);
    expect(output.mock.calls[0]![0]).toContain('  lim tunnel run --token lim_st_issued');
  });

  test('refuse to rotate the token of a quick tunnel', async () => {
    jest.mocked(findTunnel).mockResolvedValue({ ...staging, ephemeral: true });
    const { command } = setup(TunnelRotate, { name: 'staging' }, { 'expiration-months': 12 });
    await expect(command.run()).rejects.toThrow('is a quick tunnel');
    expect(rotateTunnelToken).not.toHaveBeenCalled();
  });

  test('delete the tunnel by its ID', async () => {
    jest.mocked(findTunnel).mockResolvedValue(staging);
    const { command, output } = setup(TunnelDelete, { name: 'staging' });
    await command.run();
    expect(deleteTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'tunnel_1');
    expect(output).toHaveBeenCalledWith(
      'Deleted tunnel staging. Its connector exits and its token stops working.',
    );
  });

  test.each([
    [TunnelUpdate, { selector: ['localhost:4000'] }],
    [TunnelRotate, { 'expiration-months': 12 }],
    [TunnelDelete, {}],
  ])('refuse a tunnel that does not exist (%p)', async (Command, flags) => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    const { command } = setup(Command, { name: 'missing' }, flags);
    await expect(command.run()).rejects.toThrow('Tunnel missing does not exist.');
    expect(updateTunnelSelectors).not.toHaveBeenCalled();
    expect(rotateTunnelToken).not.toHaveBeenCalled();
    expect(deleteTunnel).not.toHaveBeenCalled();
  });
});
