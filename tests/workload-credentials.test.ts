import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Limrun from '../src';
import { WorkloadCredentials } from '../src/lib/workload-credentials';

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
  const credentials = new WorkloadCredentials('https://director.example', tokenFile, fetcher);
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
