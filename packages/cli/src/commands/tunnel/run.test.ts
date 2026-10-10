import { Parser } from '@oclif/core';
import { runTunnel, type TunnelConnectorOptions } from '@limrun/api';
import TunnelRun from './run';
import {
  createQuickTunnel,
  deleteTunnel,
  findTunnel,
  tunnelOrganization,
  type PersistentTunnel,
} from '../../lib/backend';
import { formatTunnelConnectorEvent } from '../../lib/tunnel-run';

jest.mock('@limrun/api', () => ({ ...jest.requireActual('@limrun/api'), runTunnel: jest.fn() }));
jest.mock('../../lib/backend', () => ({
  tunnelOrganization: jest.fn(),
  findTunnel: jest.fn(),
  createQuickTunnel: jest.fn(),
  deleteTunnel: jest.fn(async () => {}),
  tunnelTokenClaims: jest.requireActual('../../lib/backend').tunnelTokenClaims,
}));

// A tunnel token's header and signature do not matter to the CLI; only the
// payload's claims are read.
const tunnelToken = `lim_st_eyJhbGciOiJFZERTQSJ9.${Buffer.from(
  JSON.stringify({ sub: 'org_1', scopes: ['tunnel:tunnel_01h455vb4pex5vsknk084sn02q:connect'] }),
).toString('base64url')}.c2ln`;

/** A tunnel as the backend lists it, with the fields a test cares about. */
function tunnelFixture(fields: { id: string; name: string; ephemeral: boolean }): PersistentTunnel {
  return { online: false, selectors: [], instances: [], ...fields };
}

beforeEach(() => jest.clearAllMocks());

describe('tunnel run flags', () => {
  test('need neither a name nor selectors, with inspection on by default', async () => {
    const { flags } = await Parser.parse([], { flags: TunnelRun.flags });
    expect(flags).toMatchObject({ replace: false, verbose: false, inspect: true, persist: false });
    expect(flags.name).toBeUndefined();
    expect(flags.selector).toBeUndefined();
    expect(TunnelRun.flags).not.toHaveProperty('har');
  });

  test('read the tunnel token from LIM_TUNNEL_TOKEN, never from LIM_API_KEY', async () => {
    const saved = { token: process.env['LIM_TUNNEL_TOKEN'], key: process.env['LIM_API_KEY'] };
    process.env['LIM_TUNNEL_TOKEN'] = tunnelToken;
    process.env['LIM_API_KEY'] = 'lim_admin';
    try {
      const { flags } = await Parser.parse([], { flags: TunnelRun.flags });
      expect(flags.token).toBe(tunnelToken);
      expect(flags['api-key']).toBe('lim_admin');
    } finally {
      for (const [name, value] of [
        ['LIM_TUNNEL_TOKEN', saved.token],
        ['LIM_API_KEY', saved.key],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('tunnel run command', () => {
  function setup(
    flags: { name?: string; selector?: readonly string[]; token?: string },
    { closed = Promise.resolve() }: { closed?: Promise<void> } = {},
  ) {
    jest.mocked(tunnelOrganization).mockResolvedValue('org_1');
    const close = jest.fn(async () => {});
    jest.mocked(runTunnel).mockReturnValue({ closed, close });
    const info = jest.fn();
    const command = Object.assign(Object.create(TunnelRun.prototype), {
      parse: async () => ({
        flags: {
          replace: true,
          verbose: false,
          inspect: true,
          persist: true,
          ttl: 3600,
          'har-body-limit': 1024,
          ...flags,
        },
      }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      shouldSuppressInfo: () => false,
      info,
      error: (message: string) => {
        throw new Error(message);
      },
    });
    Object.defineProperty(command, 'client', {
      value: { apiKey: 'lim_key', baseURL: 'https://api.example.test' },
    });
    return { command, info };
  }

  function options(): TunnelConnectorOptions {
    return jest.mocked(runTunnel).mock.calls[0]![0] as TunnelConnectorOptions;
  }

  test('runs the tunnel a tunnel token names with that token alone', async () => {
    const { command, info } = setup({ token: tunnelToken });
    await command.run();

    // The admin's key in the shell is never used: no backend call, and the
    // connector runs with the tunnel token.
    expect(tunnelOrganization).not.toHaveBeenCalled();
    expect(findTunnel).not.toHaveBeenCalled();
    expect(options()).toMatchObject({
      token: tunnelToken,
      baseURL: 'https://api.example.test',
      organizationId: 'org_1',
      tunnelId: 'tunnel_01h455vb4pex5vsknk084sn02q',
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: 1024, persist: true, ttlSeconds: 3600 },
      replace: true,
      logLevel: 'warn',
    });
    // The name arrives with the first active.
    options().onEvent!({ type: 'active', sessionId: 's1', name: 'staging' });
    options().onEvent!({ type: 'standby', holder: { hostname: 'ci-1' } });
    expect(info).toHaveBeenCalledWith(
      'Tunnel staging is active. Instances created with --tunnel staging attach here; press Ctrl+C to stop.',
    );
    expect(info).toHaveBeenCalledWith(
      'Standby: ci-1 holds tunnel staging. Waiting for it to go away; use --replace to take it over.',
    );
  });

  test.each([
    ['an API key', 'lim_' + 'k'.repeat(48)],
    ['a signed token for an instance', 'lim_st_e30.e30.c2ln'],
  ])('refuses %s passed as --token', async (_, token) => {
    const { command } = setup({ token });
    await expect(command.run()).rejects.toThrow('--token takes a tunnel token');
    expect(tunnelOrganization).not.toHaveBeenCalled();
  });

  test("creates a quick tunnel for --name with --selector and runs it with the tunnel's token", async () => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    jest.mocked(createQuickTunnel).mockResolvedValue({
      tunnel: tunnelFixture({ id: 'tunnel_3', name: 'scratch', ephemeral: true }),
      token: 'lim_st_quick',
    });
    const { command, info } = setup({ name: 'scratch', selector: ['localhost:3000'] });
    await command.run();

    expect(createQuickTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'scratch', ['localhost:3000']);
    // Only tunnel tokens connect, so the admin's login never reaches the hub.
    expect(options()).toMatchObject({ tunnelId: 'tunnel_3', token: 'lim_st_quick' });
    options().onEvent!({ type: 'active', sessionId: 's1', name: 'scratch' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('goes away when this connector exits'));
    expect(deleteTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'tunnel_3');
  });

  test('deletes its quick tunnel when the connector cannot start', async () => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    jest.mocked(createQuickTunnel).mockResolvedValue({
      tunnel: tunnelFixture({ id: 'tunnel_3', name: 'scratch', ephemeral: true }),
      token: 'lim_st_quick',
    });
    const { command } = setup({ name: 'scratch', selector: ['localhost:3000'] });
    jest.mocked(runTunnel).mockImplementation(() => {
      throw new Error('invalid header value');
    });
    await expect(command.run()).rejects.toThrow('invalid header value');
    expect(deleteTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'tunnel_3');
  });

  test('deletes its quick tunnel when the connector fails', async () => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    jest.mocked(createQuickTunnel).mockResolvedValue({
      tunnel: tunnelFixture({ id: 'tunnel_3', name: 'scratch', ephemeral: true }),
      token: 'lim_st_quick',
    });
    const { command } = setup(
      { name: 'scratch', selector: ['localhost:3000'] },
      { closed: Promise.reject(new Error('tunnel scratch: unauthorized')) },
    );
    await expect(command.run()).rejects.toThrow('tunnel scratch: unauthorized');
    expect(deleteTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'tunnel_3');
  });

  test.each([
    [
      'a tunnel token with selectors',
      { token: tunnelToken, selector: ['localhost:3000'] },
      'A tunnel token runs its own tunnel as created',
    ],
    [
      'a tunnel token with a name',
      { token: tunnelToken, name: 'b' },
      'A tunnel token runs its own tunnel as created',
    ],
    [
      'no token and no name',
      {},
      "Run with the tunnel's token (--token or LIM_TUNNEL_TOKEN), or pass --name and --selector for a quick tunnel.",
    ],
    [
      'a name that does not exist without selectors',
      { name: 'missing' },
      'Tunnel missing does not exist. Create it with lim tunnel create missing --selector <destination>, or ' +
        'pass --selector to run a quick tunnel.',
    ],
  ] as const)('refuses %s', async (_, flags, message) => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    const { command } = setup(flags);
    await expect(command.run()).rejects.toThrow(message);
    expect(runTunnel).not.toHaveBeenCalled();
  });

  test.each([[{ name: 'staging' }], [{ name: 'staging', selector: ['localhost:3000'] }]] as const)(
    'refuses to run a console-created tunnel without its token (%j)',
    async (flags) => {
      jest
        .mocked(findTunnel)
        .mockResolvedValue(tunnelFixture({ id: 'tunnel_2', name: 'staging', ephemeral: false }));
      const { command } = setup(flags);
      await expect(command.run()).rejects.toThrow('Tunnel staging runs with its own token (--token)');
      expect(runTunnel).not.toHaveBeenCalled();
      expect(createQuickTunnel).not.toHaveBeenCalled();
    },
  );

  test.each([[{ name: 'scratch' }], [{ name: 'scratch', selector: ['localhost:3000'] }]] as const)(
    "refuses another connector's quick tunnel (%j)",
    async (flags) => {
      jest
        .mocked(findTunnel)
        .mockResolvedValue(tunnelFixture({ id: 'tunnel_3', name: 'scratch', ephemeral: true }));
      const { command } = setup(flags);
      await expect(command.run()).rejects.toThrow("Tunnel scratch is another connector's quick tunnel");
      expect(runTunnel).not.toHaveBeenCalled();
    },
  );

  test('fails with the terminal connector error', async () => {
    const { command } = setup(
      { token: tunnelToken },
      { closed: Promise.reject(new Error('tunnel staging: the tunnel was deleted')) },
    );
    await expect(command.run()).rejects.toThrow('tunnel staging: the tunnel was deleted');
  });
});

describe('tunnel run event lines', () => {
  test.each([
    [
      { type: 'active', sessionId: 'session-1', name: 'staging' },
      'Tunnel staging is active. Instances created with --tunnel staging attach here; press Ctrl+C to stop.',
    ],
    [
      { type: 'tokenExpiring', expiresAt: '2026-10-20T00:00:00Z' },
      'The token this connector runs with expires at 2026-10-20T00:00:00Z. Issue a new one with ' +
        'lim tunnel rotate staging and restart the connector with it.',
    ],
    [
      { type: 'standby', holder: { hostname: 'ci-1', since: '2026-10-08T10:00:00Z' } },
      'Standby: ci-1 holds tunnel staging since 2026-10-08T10:00:00Z. ' +
        'Waiting for it to go away; use --replace to take it over.',
    ],
    [
      { type: 'attachFailed', instanceId: 'ios_1', code: 'instance_busy', message: 'busy' },
      'Could not attach ios_1: busy (instance_busy).',
    ],
    [
      { type: 'reconnecting', delayMs: 1500, reason: 'the server asked to reconnect (1012)' },
      'Reconnecting to Limrun in 1.5s: the server asked to reconnect (1012). Attached instances keep their tunnels.',
    ],
    [
      {
        type: 'reconnecting',
        instanceId: 'ios_1',
        delayMs: 1000,
        reason: 'the instance tunnel disconnected',
      },
      'Retrying ios_1 in 1.0s: the instance tunnel disconnected.',
    ],
  ] as const)('formats %j', (event, line) => {
    expect(formatTunnelConnectorEvent('staging', event)).toBe(line);
  });

  test('names the tunnel generically before the first active', () => {
    expect(formatTunnelConnectorEvent(undefined, { type: 'standby', holder: { hostname: 'ci-1' } })).toBe(
      'Standby: ci-1 holds the tunnel. Waiting for it to go away; use --replace to take it over.',
    );
  });

  test('says a quick tunnel goes with its connector, and restarts for a new token', () => {
    expect(
      formatTunnelConnectorEvent('scratch', { type: 'active', sessionId: 's1', name: 'scratch' }, true),
    ).toBe(
      'Tunnel scratch is active. Instances created with --tunnel scratch attach here; press Ctrl+C to stop. ' +
        'It is a quick tunnel and goes away when this connector exits.',
    );
    expect(
      formatTunnelConnectorEvent(
        'scratch',
        { type: 'tokenExpiring', expiresAt: '2026-10-20T00:00:00Z' },
        true,
      ),
    ).toBe(
      'The token of quick tunnel scratch expires at 2026-10-20T00:00:00Z. Restart the connector to get a new one.',
    );
  });
});
