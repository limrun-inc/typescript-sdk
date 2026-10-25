import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Limrun, { assetNameTarget } from '../src';
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
  const fetcher = jest.fn(async (_url: unknown, init?: RequestInit) => {
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
    Response.json({ scopes: [], expiresAt: new Date(Date.now() + 600000).toISOString() }),
  );
  const client = new Limrun({
    apiKey: null,
    workloadTokenFile: tokenFile,
    baseURL: 'https://director.example',
    fetch: fetcher,
    maxRetries: 0,
  });
  await expect(client.assets.createUploadURL('asset_01h455vb4pex5vsknk084sn02q')).rejects.toThrow(
    'no workload asset permissions',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('exact asset names use the same canonical encoding as the API', () => {
  expect(assetNameTarget('release/a:b *.apk')).toBe('name/release%2Fa%3Ab%20%2A.apk');
  expect(assetNameTarget("!'()~")).toBe('name/%21%27%28%29~');
});
