import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { syncFolder } from '../src/folder-sync';

// Encoding and HTTP retry share this budget on loaded CI workers.
jest.setTimeout(30_000);

const fixtures = path.join(__dirname, 'fixtures/android-apk-sync');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-apk-sync-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing receiver bases retry the original signed APK without compression', async () => {
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
    });
    expect(kinds).toEqual(['delta', 'full']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
