import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { encodeApkDelta } from '../src/internal/apk-delta';
import { encodeXdelta3Patch, syncFolder } from '../src/folder-sync';

// Encoding and HTTP retry share this budget on loaded CI workers.
jest.setTimeout(30_000);

const fixtures = path.join(__dirname, 'fixtures/apk-delta');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-delta-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a small bundle edit in a signed APK produces a small archive patch', async () => {
  const old = path.join(fixtures, 'old.apk');
  const next = path.join(fixtures, 'new.apk');
  const patch = path.join(dir, 'patch');
  const archiveSize = await encodeApkDelta(old, next, patch, 1 << 20, encodeXdelta3Patch);
  const rawSize = await encodeXdelta3Patch(old, next, path.join(dir, 'raw'), 1 << 20);
  expect(archiveSize).toBeGreaterThan(0);
  expect(archiveSize).toBeLessThan(rawSize / 10);
  const bytes = fs.readFileSync(patch);
  const headerLength = bytes.readUInt32BE(0);
  const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString());
  expect(header.version).toBe(1);
  expect(header.newSize).toBe(fs.statSync(next).size);
  expect(header.next.length).toBeGreaterThan(0);
});

test('invalid archives and oversized patches fall back without leaking temporary files', async () => {
  const invalid = path.join(dir, 'invalid.apk');
  fs.writeFileSync(invalid, 'not a zip');
  const patch = path.join(dir, 'patch');
  expect(await encodeApkDelta(invalid, invalid, patch, 100, encodeXdelta3Patch)).toBe(-1);
  expect(
    await encodeApkDelta(
      path.join(fixtures, 'old.apk'),
      path.join(fixtures, 'new.apk'),
      patch,
      10,
      encodeXdelta3Patch,
    ),
  ).toBe(-1);
  expect(fs.readdirSync(dir)).toEqual(['invalid.apk']);
});

test('receiver reconstruction failures retry the original signed APK without compression', async () => {
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache);
  fs.copyFileSync(path.join(fixtures, 'old.apk'), path.join(cache, 'new.apk'));
  const kinds: string[] = [];
  const server = http.createServer(async (req, res) => {
    expect(req.headers['content-encoding']).toBeUndefined();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const length = body.readUInt32BE(0);
    const meta = JSON.parse(body.subarray(4, 4 + length).toString());
    kinds.push(meta.payloads[0].kind);
    res.setHeader('Content-Type', 'application/json');
    if (kinds.length === 1) res.end(JSON.stringify({ ok: false, needFull: ['new.apk'] }));
    else {
      expect(body.subarray(4 + length)).toEqual(fs.readFileSync(path.join(fixtures, 'new.apk')));
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await syncFolder(path.join(fixtures, 'new.apk'), {
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'test',
      udid: 'test',
      basisCacheDir: cache,
      install: true,
      launchMode: 'None',
      watch: false,
      log: () => {},
      ignoreFn: () => false,
      compression: 'identity',
      apkDelta: true,
    });
    expect(kinds).toEqual(['apk-delta-v1', 'full']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
