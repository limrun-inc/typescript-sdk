import { Parser } from '@oclif/core';
import { runTunnel, type TunnelConnectorOptions } from '@limrun/api';
import TunnelRun from './run';
import { createQuickTunnel, findTunnel, whoAmITunnel } from '../../lib/backend';
import { formatTunnelConnectorEvent } from '../../lib/tunnel-run';

jest.mock('@limrun/api', () => ({ ...jest.requireActual('@limrun/api'), runTunnel: jest.fn() }));
jest.mock('../../lib/backend', () => ({
  whoAmITunnel: jest.fn(),
  findTunnel: jest.fn(),
  createQuickTunnel: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

describe('tunnel run flags', () => {
  test('need neither a name nor selectors, with inspection on by default', async () => {
    const { flags } = await Parser.parse([], { flags: TunnelRun.flags });
    expect(flags).toMatchObject({ replace: false, verbose: false, inspect: true, persist: false });
    expect(flags.name).toBeUndefined();
    expect(flags.selector).toBeUndefined();
    expect(TunnelRun.flags).not.toHaveProperty('har');
  });
});

describe('tunnel run command', () => {
  function setup(
    flags: { name?: string; selector?: readonly string[] },
    { keyTunnelId, closed = Promise.resolve() }: { keyTunnelId?: string; closed?: Promise<void> } = {},
  ) {
    jest
      .mocked(whoAmITunnel)
      .mockResolvedValue({ organizationId: 'org_1', ...(keyTunnelId ? { tunnelId: keyTunnelId } : {}) });
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

  test('runs the tunnel a tunnel key names, with the mapped options', async () => {
    const { command, info } = setup({}, { keyTunnelId: 'tunnel_1' });
    await command.run();

    expect(findTunnel).not.toHaveBeenCalled();
    expect(options()).toMatchObject({
      apiKey: 'lim_key',
      baseURL: 'https://api.example.test',
      organizationId: 'org_1',
      tunnelId: 'tunnel_1',
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

  test('runs the tunnel an admin names', async () => {
    jest.mocked(findTunnel).mockResolvedValue({ id: 'tunnel_2', name: 'staging', ephemeral: false });
    const { command } = setup({ name: 'staging' });
    await command.run();

    expect(findTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'staging');
    expect(options()).toMatchObject({ tunnelId: 'tunnel_2' });
    expect(createQuickTunnel).not.toHaveBeenCalled();
  });

  test('creates a throwaway tunnel for --name with --selector', async () => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    jest.mocked(createQuickTunnel).mockResolvedValue({ id: 'tunnel_3', name: 'scratch', ephemeral: true });
    const { command, info } = setup({ name: 'scratch', selector: ['localhost:3000'] });
    await command.run();

    expect(createQuickTunnel).toHaveBeenCalledWith(expect.anything(), 'org_1', 'scratch', ['localhost:3000']);
    expect(options()).toMatchObject({ tunnelId: 'tunnel_3' });
    options().onEvent!({ type: 'active', sessionId: 's1', name: 'scratch' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('goes away when this connector exits'));
  });

  test.each([
    [
      'a tunnel key with selectors',
      { selector: ['localhost:3000'] },
      'tunnel_1',
      'A tunnel key runs its own tunnel as created',
    ],
    ['a tunnel key with a name', { name: 'b' }, 'tunnel_1', 'A tunnel key runs its own tunnel as created'],
    [
      'no key and no name',
      {},
      undefined,
      "Run with the tunnel's key (LIM_API_KEY), or pass --name with an admin's credential.",
    ],
    [
      'a name that does not exist without selectors',
      { name: 'missing' },
      undefined,
      'Tunnel missing does not exist. Create it in the console (Network > New tunnel), or pass --selector to ' +
        'run a throwaway tunnel.',
    ],
  ] as const)('refuses %s', async (_, flags, keyTunnelId, message) => {
    jest.mocked(findTunnel).mockResolvedValue(undefined);
    const { command } = setup(flags, keyTunnelId ? { keyTunnelId } : {});
    await expect(command.run()).rejects.toThrow(message);
    expect(runTunnel).not.toHaveBeenCalled();
  });

  test('refuses selectors for a tunnel that has its own', async () => {
    jest.mocked(findTunnel).mockResolvedValue({ id: 'tunnel_2', name: 'staging', ephemeral: false });
    const { command } = setup({ name: 'staging', selector: ['localhost:3000'] });
    await expect(command.run()).rejects.toThrow('Tunnel staging has its own selectors');
  });

  test.each([[{ name: 'scratch' }], [{ name: 'scratch', selector: ['localhost:3000'] }]] as const)(
    "refuses another connector's throwaway tunnel (%j)",
    async (flags) => {
      jest.mocked(findTunnel).mockResolvedValue({ id: 'tunnel_3', name: 'scratch', ephemeral: true });
      const { command } = setup(flags);
      await expect(command.run()).rejects.toThrow("Tunnel scratch is another connector's throwaway tunnel");
      expect(runTunnel).not.toHaveBeenCalled();
    },
  );

  test('fails with the terminal connector error', async () => {
    const { command } = setup(
      {},
      {
        keyTunnelId: 'tunnel_1',
        closed: Promise.reject(new Error('tunnel staging: the tunnel was deleted')),
      },
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
      { type: 'keyExpiring', expiresAt: '2026-10-20T00:00:00Z' },
      'The key this connector runs with expires at 2026-10-20T00:00:00Z. Issue a new key for tunnel staging ' +
        'in the console (Network) and restart the connector with it.',
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

  test('says a throwaway tunnel goes with its connector', () => {
    expect(
      formatTunnelConnectorEvent('scratch', { type: 'active', sessionId: 's1', name: 'scratch' }, true),
    ).toBe(
      'Tunnel scratch is active. Instances created with --tunnel scratch attach here; press Ctrl+C to stop. ' +
        'It is a throwaway tunnel and goes away when this connector exits.',
    );
  });
});
