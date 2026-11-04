import { Parser } from '@oclif/core';
import { generateKeyPairSync, sign } from 'node:crypto';
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

const { privateKey } = generateKeyPairSync('ed25519');

function accessToken(claims: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `lim_st_${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

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

test.each([false, true])('revoke extracts jti from an access token (json=%s)', async (asJson) => {
  const token = accessToken({
    iss: 'limrun',
    sub: 'org_01h455vb4pex5vsknk084sn02z',
    owner: 'token_01h455vb4pex5vsknk084sn02z',
    jti: issued.id,
    exp: 1,
    scopes: ['device:*:install'],
  });
  const { command, calls, json, output } = setup(Revoke, [token, ...(asJson ? ['--json'] : [])]);
  await command.run();
  expect(calls).toEqual([{ path: `/v1/access_tokens/${issued.id}`, method: 'DELETE' }]);
  if (asJson) {
    expect(json).toHaveBeenCalledWith({ ok: true, id: issued.id });
    expect(output).not.toHaveBeenCalled();
  } else {
    expect(output).toHaveBeenCalledWith(`Revoked access token ${issued.id}.`);
    expect(json).not.toHaveBeenCalled();
  }
  expect(JSON.stringify([calls, json.mock.calls, output.mock.calls])).not.toContain(token);
});

test.each([
  ['an API key', 'lim_not_an_access_token', /Expected an access-token ID/],
  ['a malformed JWT', 'lim_st_invalid', /Malformed access token/],
  ['a malformed payload', 'lim_st_e30.bm90LWpzb24.c2ln', /Malformed access token/],
  ['a non-object payload', accessToken(null), /JWT claims object/],
  ['an array payload', accessToken([]), /JWT claims object/],
  ['an instance token', accessToken({ scopes: ['ios:ios_euna_01h455vb4pex5vsknk084sn02q:all'] }), /no jti/],
  ['an empty jti', accessToken({ jti: '' }), /no jti/],
  ['a numeric jti', accessToken({ jti: 123 }), /invalid jti/],
  ['a non-UUID jti', accessToken({ jti: '../other-resource' }), /invalid jti/],
] as const)('revoke rejects %s without sending or printing the credential', async (_name, input, message) => {
  const { command, calls, json, output } = setup(Revoke, [input, '--json']);
  let failure: unknown;
  try {
    await command.run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(message);
  expect((failure as Error).message).not.toContain(input);
  expect(calls).toEqual([]);
  expect(json).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

test('failed revocation prints no success result', async () => {
  const { command, json, output } = setup(Revoke, [issued.id, '--json'], 403);
  await expect(command.run()).rejects.toThrow();
  expect(json).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});
