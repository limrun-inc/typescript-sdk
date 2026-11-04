import { Parser } from '@oclif/core';
import Limrun from '@limrun/api';
import Create from './create';
import Revoke from './revoke';

const issued = {
  id: '1fc6ec70-af2a-4b31-8e0d-b20c42cc6322',
  token: 'lim_st_test',
  permissions: ['asset:name/releases/app:prod,1.ipa:read', 'device:*:install'],
  scopes: ['asset:name/releases/app:prod,1.ipa:read', 'device:*:install'],
  expiresAt: '2026-11-04T12:15:00Z',
};

function setup(Command: typeof Create | typeof Revoke, argv: string[], status = 200) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const client = new Limrun({
    apiKey: 'lim_test',
    baseURL: 'https://api.example.test',
    maxRetries: 0,
    fetch: async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer lim_test');
      calls.push({
        path: new URL(input.toString()).pathname,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
      });
      return Response.json(
        status === 200 ?
          init?.method === 'DELETE' ?
            { status: 'OK' }
          : issued
        : { message: 'forbidden' },
        { status },
      );
    },
  });
  const output = jest.fn();
  const json = jest.fn();
  const command = Object.assign(Object.create(Command.prototype), {
    parse: () =>
      Command === Revoke ?
        Parser.parse(argv, { flags: Revoke.flags, args: Revoke.args })
      : Parser.parse(argv, { flags: Create.flags }),
    withAuth: async (run: () => Promise<void>) => run(),
    setParsedFlags: jest.fn(),
    output,
    outputJson: json,
    outputResult: (data: unknown, message: string) =>
      argv.includes('--json') ? json(data) : output(message),
  });
  Object.defineProperty(command, 'client', { value: client });
  return { command, calls, output, json };
}

test('repeated permissions preserve literal asset names and produce one JSON result', async () => {
  const { command, calls, output, json } = setup(Create, [
    '--permission',
    issued.permissions[0]!,
    '--permission',
    issued.permissions[1]!,
    '--ttl-seconds',
    '900',
    '--json',
    '--quiet',
  ]);
  await command.run();
  expect(calls).toEqual([
    { path: '/v1/access_tokens', method: 'POST', body: { permissions: issued.permissions, ttlSeconds: 900 } },
  ]);
  expect(json).toHaveBeenCalledTimes(1);
  expect(json).toHaveBeenCalledWith(issued);
  expect(output).not.toHaveBeenCalled();
});

test('quiet output contains only the token and leaves the default TTL to the server', async () => {
  const { command, calls, output } = setup(Create, ['--permission', 'asset:*:read', '--quiet']);
  await command.run();
  expect(calls[0]!.body).toEqual({ permissions: ['asset:*:read'] });
  expect(output).toHaveBeenCalledWith(issued.token);
});

test.each([
  [],
  ['--permission', 'asset:*:read', '--ttl-seconds', '0'],
  ['--permission', 'asset:*:read', '--ttl-seconds', '14401'],
])('invalid flags never reach the API: %j', async (...argv: string[]) => {
  const { command, calls } = setup(Create, argv);
  await expect(command.run()).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('revoke sends the ID to the canonical endpoint', async () => {
  const { command, calls, json } = setup(Revoke, [issued.id, '--json']);
  await command.run();
  expect(calls).toEqual([{ path: `/v1/access_tokens/${issued.id}`, method: 'DELETE' }]);
  expect(json).toHaveBeenCalledWith({ ok: true, id: issued.id });
});

test('failed revocation prints no success result', async () => {
  const { command, json, output } = setup(Revoke, [issued.id, '--json'], 403);
  await expect(command.run()).rejects.toThrow();
  expect(json).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});
