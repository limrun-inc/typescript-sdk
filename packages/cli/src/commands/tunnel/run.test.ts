import { Parser } from '@oclif/core';
import { runTunnel, type TunnelConnectorOptions } from '@limrun/api';
import TunnelRun from './run';
import { whoAmI } from '../../lib/backend';
import { formatTunnelConnectorEvent } from '../../lib/tunnel-run';

jest.mock('@limrun/api', () => ({ ...jest.requireActual('@limrun/api'), runTunnel: jest.fn() }));
jest.mock('../../lib/backend', () => ({ whoAmI: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

describe('tunnel run flags', () => {
  test('parse the name and selectors with inspection on by default', async () => {
    const { flags } = await Parser.parse(['--name', 'staging-2', '--selector', 'localhost:3000'], {
      flags: TunnelRun.flags,
    });
    expect(flags).toMatchObject({
      name: 'staging-2',
      selector: ['localhost:3000'],
      replace: false,
      verbose: false,
      inspect: true,
      persist: false,
    });
    expect(TunnelRun.flags).not.toHaveProperty('har');
  });
});

describe('tunnel run command', () => {
  function setup(closed: Promise<void>) {
    jest.mocked(whoAmI).mockResolvedValue('org_1');
    const close = jest.fn(async () => {});
    jest.mocked(runTunnel).mockReturnValue({ closed, close });
    const info = jest.fn();
    const command = Object.assign(Object.create(TunnelRun.prototype), {
      parse: async () => ({
        flags: {
          name: 'staging',
          selector: ['localhost:3000', '*.corp.example'],
          replace: true,
          verbose: false,
          inspect: true,
          persist: true,
          ttl: 3600,
          'har-body-limit': 1024,
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

  test('connects as the resolved organization with the mapped options', async () => {
    const { command, info } = setup(Promise.resolve());
    await command.run();

    const options = jest.mocked(runTunnel).mock.calls[0]![0] as TunnelConnectorOptions;
    expect(options).toMatchObject({
      apiKey: 'lim_key',
      baseURL: 'https://api.example.test',
      organizationId: 'org_1',
      name: 'staging',
      selectors: ['localhost:3000', '*.corp.example'],
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: 1024, persist: true, ttlSeconds: 3600 },
      replace: true,
      logLevel: 'warn',
    });
    options.onEvent!({ type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-1' });
    expect(info).toHaveBeenCalledWith('Attached ios_1 (tunnel tun-1).');
  });

  test('fails with the terminal connector error', async () => {
    const { command } = setup(Promise.reject(new Error('tunnel staging: the tunnel was deleted')));
    await expect(command.run()).rejects.toThrow('tunnel staging: the tunnel was deleted');
  });
});

describe('tunnel run event lines', () => {
  test.each([
    [
      { type: 'active', sessionId: 'session-1' },
      'Tunnel staging is active. Instances created with --tunnel staging attach here; press Ctrl+C to stop.',
    ],
    [
      { type: 'standby', holder: { hostname: 'ci-1', since: '2026-10-08T10:00:00Z' } },
      'Standby: ci-1 holds tunnel staging since 2026-10-08T10:00:00Z. ' +
        'Waiting for it to go away; use --replace to take the name over.',
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
});
