import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Limrun from '../src';
import { WorkloadCredentials, workloadTokenFileReader } from '../src/lib/workload-credentials';

let dir: string;
let tokenFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'limrun-workload-'));
  tokenFile = join(dir, 'identity');
  await writeFile(tokenFile, 'projected');
});
afterEach(async () => {
  await rm(dir, { recursive: true });
  jest.restoreAllMocks();
});

test('lazy exchange, concurrent requests, and rotated identity refresh', async () => {
  const calls: string[] = [];
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    expect(url).toBe('https://director.example/v1/access_tokens');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({});
    calls.push(new Headers(init?.headers).get('Authorization')!);
    return Response.json({ token: 'scoped', expiresAt: new Date(Date.now() + 600000).toISOString() });
  });
  const credentials = new WorkloadCredentials(
    'https://director.example',
    workloadTokenFileReader(tokenFile),
    fetcher,
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(await Promise.all([credentials.get(), credentials.get()])).toEqual(['scoped', 'scoped']);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await writeFile(tokenFile, 'rotated');
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + 550000);
  expect(await credentials.get()).toBe('scoped');
  expect(calls).toEqual(['Bearer projected', 'Bearer rotated']);
});

test('explicit API key never exchanges or falls back after refusal', async () => {
  const fetcher = jest.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json({ message: 'denied' }, { status: 403 }),
  );
  const client = new Limrun({
    apiKey: 'customer-scoped',
    workloadTokenFile: tokenFile,
    baseURL: 'https://director.example',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
    'Bearer customer-scoped',
  );
});

test('empty workload scopes fail before calling the asset endpoint', async () => {
  const fetcher = jest.fn(async () =>
    Response.json({ message: 'This instance has no delegated asset permissions' }, { status: 403 }),
  );
  const client = new Limrun({
    apiKey: null,
    workloadTokenFile: tokenFile,
    baseURL: 'https://director.example',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q')).rejects.toThrow(
    'Workload token exchange returned HTTP 403',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  {
    name: 'discovered workload identity',
    options: {},
    endpoint: 'https://director.example',
    exchanges: true,
  },
  {
    name: 'explicit workload file overrides discovery',
    options: { workloadTokenFile: 'configured' },
    endpoint: 'https://director.example',
    exchanges: true,
  },
  {
    name: 'explicit base URL overrides director discovery',
    options: { baseURL: 'https://custom.example' },
    endpoint: 'https://custom.example',
    exchanges: true,
  },
  {
    name: 'explicit key bypasses workload discovery',
    options: { apiKey: 'explicit' },
    endpoint: 'https://api.limrun.com',
    exchanges: false,
  },
])('$name', async ({ options, endpoint, exchanges }) => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    LIM_API_KEY: '',
    LIMRUN_BASE_URL: '',
    DIRECTOR_URL: 'https://director.example',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: options.workloadTokenFile ? 'missing-file' : tokenFile,
  });
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v1/access_tokens')) {
      expect(url).toBe(`${endpoint}/v1/access_tokens`);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer projected');
      return Response.json({ token: 'exchanged', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    expect(url).toBe(`${endpoint}/v1/assets/asset_01h455vb4pex5vsknk084sn02q/upload_urls`);
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      exchanges ? 'Bearer exchanged' : 'Bearer explicit',
    );
    return Response.json({ signedUploadUrl: 'https://storage.example/upload' });
  });
  const client = new Limrun({
    apiKey: null,
    ...options,
    ...(options.workloadTokenFile && { workloadTokenFile: tokenFile }),
    fetch: fetcher,
  });
  await client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q');
  expect(fetcher).toHaveBeenCalledTimes(exchanges ? 2 : 1);
});

test('null workload token file disables identity and director discovery', async () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    LIMRUN_BASE_URL: '',
    DIRECTOR_URL: 'https://director.example',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: tokenFile,
  });
  const fetcher = jest.fn();
  const client = new Limrun({ apiKey: null, workloadTokenFile: null, fetch: fetcher });
  expect(client.baseURL).toBe('https://api.limrun.com');
  await expect(client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test('workload exchange uses client transport options without allowing credential redirects', async () => {
  const dispatcher = {} as import('undici').Dispatcher;
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    expect(init).toEqual(expect.objectContaining({ dispatcher, keepalive: true }));
    if (String(url).endsWith('/v1/access_tokens')) {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer projected');
      return Response.json({ token: 'exchanged', expiresAt: new Date(Date.now() + 600000).toISOString() });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer exchanged');
    return Response.json({ signedUploadUrl: 'https://storage.example/upload' });
  });
  const client = new Limrun({
    apiKey: null,
    workloadTokenFile: tokenFile,
    baseURL: 'https://director.example',
    fetch: fetcher,
    fetchOptions: { dispatcher, keepalive: true, redirect: 'follow' },
  });
  await client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('federation uses the binding and renews from the rotated file', async () => {
  const identities: string[] = [];
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    expect(url).toBe('https://sts.example/v1/access_tokens');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    const form = new URLSearchParams(init?.body as string);
    expect(form.get('audience')).toBe('binding_customer');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    identities.push(form.get('subject_token')!);
    return Response.json({
      access_token: `session-${identities.length}`,
      token_type: 'Bearer',
      expires_in: 30,
    });
  });
  const credentials = new WorkloadCredentials(
    'https://sts.example',
    workloadTokenFileReader(tokenFile),
    fetcher,
    undefined,
    'binding_customer',
  );
  expect(await Promise.all([credentials.get(), credentials.get()])).toEqual(['session-1', 'session-1']);
  expect(await credentials.get()).toBe('session-1');
  await writeFile(tokenFile, 'rotated');
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + 25000);
  expect(await credentials.get()).toBe('session-2');
  expect(identities).toEqual(['projected', 'rotated']);
});

test('federation client authenticates API calls with the exchanged token', async () => {
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v1/access_tokens')) {
      expect(url).toBe('https://sts.limrun.com/v1/access_tokens');
      return Response.json({ access_token: 'limrun-session', token_type: 'Bearer', expires_in: 900 });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer limrun-session');
    expect(String(url)).toContain('https://api.limrun.com/');
    return Response.json({ items: [] });
  });
  const client = new Limrun({
    apiKey: null,
    workloadTokenFile: tokenFile,
    bindingId: 'binding_customer',
    fetch: fetcher,
  });
  await client.iosInstances.list();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('federation refusal never calls the requested API or reuses an expired session', async () => {
  const fetcher = jest.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const client = new Limrun({
    apiKey: null,
    workloadTokenFile: tokenFile,
    bindingId: 'binding_customer',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.iosInstances.list()).rejects.toThrow('Workload token exchange returned HTTP 400');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('discovers customer federation from workload identity environment variables', async () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    LIM_API_KEY: '',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: tokenFile,
    LIMRUN_WORKLOAD_IDENTITY_BINDING_ID: 'binding_environment',
    LIMRUN_STS_BASE_URL: 'https://sts.example.com',
  });
  const fetcher = jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v1/access_tokens')) {
      expect(url).toBe('https://sts.example.com/v1/access_tokens');
      const form = new URLSearchParams(init?.body as string);
      expect(form.get('audience')).toBe('binding_environment');
      expect(form.get('subject_token')).toBe('projected');
      return Response.json({ access_token: 'limrun-session', token_type: 'Bearer', expires_in: 900 });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer limrun-session');
    return Response.json({ items: [] });
  });
  await new Limrun({ fetch: fetcher }).iosInstances.list();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each(['explicit', 'environment'])(
  '%s API key bypasses incomplete federation configuration',
  async (source) => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      LIM_API_KEY: source === 'environment' ? 'key' : '',
      LIMRUN_WORKLOAD_IDENTITY_BINDING_ID: 'binding_unused',
      LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: '',
    });
    const fetcher = jest.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
      return Response.json({ items: [] });
    });
    const client = new Limrun({ ...(source === 'explicit' ? { apiKey: 'key' } : {}), fetch: fetcher });
    await client.androidInstances.list();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

/** Answers the STS with a short session per exchange and authenticated API calls with an empty list. */
function federationFetcher(subjects: string[]) {
  return jest.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/v1/access_tokens')) {
      const form = new URLSearchParams(init?.body as string);
      expect(form.get('audience')).toBe('binding_customer');
      subjects.push(form.get('subject_token')!);
      return Response.json({
        access_token: `session-${subjects.length}`,
        token_type: 'Bearer',
        expires_in: 30,
      });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer session-${subjects.length}`);
    return Response.json({ items: [] });
  });
}

test('federation accepts the workload JWT as a string', async () => {
  const subjects: string[] = [];
  const client = new Limrun({
    apiKey: null,
    workloadToken: ' provided-jwt\n',
    bindingId: 'binding_customer',
    fetch: federationFetcher(subjects),
  });
  await client.iosInstances.list();
  expect(subjects).toEqual(['provided-jwt']);
});

test('a workload token function supplies a fresh JWT on every renewal', async () => {
  const subjects: string[] = [];
  let issued = 0;
  const workloadToken = jest.fn(async () => `jwt-${++issued}`);
  const client = new Limrun({
    apiKey: null,
    workloadToken,
    bindingId: 'binding_customer',
    fetch: federationFetcher(subjects),
  });
  expect(workloadToken).not.toHaveBeenCalled();
  await client.iosInstances.list();
  await client.iosInstances.list();
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + 25000);
  await client.iosInstances.list();
  expect(subjects).toEqual(['jwt-1', 'jwt-2']);
});

test('a workload token function failure rejects the request without calling the API', async () => {
  const fetcher = jest.fn();
  const client = new Limrun({
    apiKey: null,
    workloadToken: () => {
      throw new Error('identity provider is down');
    },
    bindingId: 'binding_customer',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.iosInstances.list()).rejects.toThrow('identity provider is down');
  expect(fetcher).not.toHaveBeenCalled();
});

test('an empty workload token is refused before the exchange', async () => {
  const fetcher = jest.fn();
  const client = new Limrun({
    apiKey: null,
    workloadToken: () => '  ',
    bindingId: 'binding_customer',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.iosInstances.list()).rejects.toThrow('Workload identity token must be a JWT');
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  {
    name: 'discovers the token environment variable',
    options: {},
    env: { token: 'env-jwt' },
    subject: 'env-jwt',
  },
  {
    name: 'prefers the token environment variable over the file one',
    options: {},
    env: { token: 'env-jwt', file: true },
    subject: 'env-jwt',
  },
  {
    name: 'an explicit token beats both environment variables',
    options: { workloadToken: 'explicit-jwt' },
    env: { token: 'env-jwt', file: true },
    subject: 'explicit-jwt',
  },
  {
    name: 'an explicit file beats the token environment variable',
    options: { workloadTokenFile: 'file' },
    env: { token: 'env-jwt' },
    subject: 'projected',
  },
  {
    name: 'null token turns off its environment variable',
    options: { workloadToken: null },
    env: { token: 'env-jwt', file: true },
    subject: 'projected',
  },
])('$name', async ({ options, env, subject }) => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    LIM_API_KEY: '',
    LIMRUN_WORKLOAD_IDENTITY_BINDING_ID: 'binding_customer',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN: env.token ?? '',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: 'file' in env ? tokenFile : '',
  });
  const subjects: string[] = [];
  const client = new Limrun({
    ...options,
    ...('workloadTokenFile' in options && { workloadTokenFile: tokenFile }),
    fetch: federationFetcher(subjects),
  });
  await client.iosInstances.list();
  expect(subjects).toEqual([subject]);
});

test('federation without any workload identity names every source', () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    LIM_API_KEY: '',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN: '',
    LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE: '',
  });
  expect(() => new Limrun({ bindingId: 'binding_customer' })).toThrow(
    'Federation requires workloadToken, workloadTokenFile, LIMRUN_WORKLOAD_IDENTITY_TOKEN, or LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE',
  );
});
