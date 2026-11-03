import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import { createInstanceClient as createAndroidClient } from '../src/instance-client';
import { createInstanceClient as createIosClient } from '../src/ios-client';
import type { SyncLaunchMode } from '../src/folder-sync';

type Manifest = {
  install: boolean;
  launchMode: string;
  rootName: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  payloads: unknown[];
};

describe.each(['android', 'ios'] as const)('%s sync launch mode', (platform) => {
  test.each([undefined, 'None', 'ForegroundIfRunning', 'RelaunchIfRunning'] as const)(
    'sends %s on initial and unchanged installs',
    async (launchMode: SyncLaunchMode | undefined) => {
      const directory = await mkdtemp(join(tmpdir(), 'limrun-sync-launch-'));
      const appPath = join(directory, platform === 'ios' ? 'Demo.app' : 'demo.apk');
      if (platform === 'ios') {
        await mkdir(appPath);
        await writeFile(join(appPath, 'Info.plist'), '<plist><dict/></plist>');
        await writeFile(join(directory, 'executable'), 'linked executable', { mode: 0o755 });
        await symlink('../executable', join(appPath, 'Demo'));
        await mkdir(join(directory, 'resources'));
        await writeFile(join(directory, 'resources', 'icon.txt'), 'linked resource');
        await symlink('../resources', join(appPath, 'Resources'));
      } else {
        await writeFile(appPath, Buffer.from('PK\x03\x04apk-fixture'));
      }
      const requests: Manifest[] = [];
      const authorizations: Array<string | undefined> = [];
      const server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('/sync/state')) {
          res.end(JSON.stringify({ roots: requests.slice(-1) }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          let body = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
          if (req.headers['content-encoding'] === 'zstd') body = (zlib as any).zstdDecompressSync(body);
          const length = body.readUInt32BE(0);
          requests.push(JSON.parse(body.subarray(4, 4 + length).toString()) as Manifest);
          authorizations.push(req.headers.authorization);
          res.end(JSON.stringify({ ok: true, bundleId: 'com.example.demo' }));
        });
      });
      const signaling = new WebSocketServer({
        server,
        path: platform === 'ios' ? '/api/signaling' : '/api/ws',
      });
      signaling.on('connection', (socket) => {
        socket.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'deviceInfo') {
            socket.send(JSON.stringify({ type: 'deviceInfoResult', id: message.id, udid: 'test-simulator' }));
          }
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const createClient = platform === 'ios' ? createIosClient : createAndroidClient;
      const client = await createClient({ apiUrl, token: 'instance-token', logLevel: 'none' });
      try {
        const options = {
          install: true,
          watch: false,
          ...(launchMode ? { launchMode } : {}),
          basisCacheDir: join(directory, 'basis'),
        };
        const first = await client.syncApp(appPath, options);
        const second = await client.syncApp(appPath, options);
        expect(first.installedBundleId).toBe('com.example.demo');
        expect(second.installedBundleId).toBe('com.example.demo');
        expect(second.bytesSent).toBe(0);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.install).toBe(true);
          expect(request.launchMode).toBe(launchMode ?? 'ForegroundIfRunning');
        }
        expect(requests[0]!.payloads.length).toBeGreaterThan(0);
        if (platform === 'ios') {
          expect(requests[0]!.files).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: 'Demo', size: 17, mode: 0o755 }),
              expect.objectContaining({ path: 'Resources/icon.txt', size: 15 }),
            ]),
          );
        }
        expect(requests[1]!.payloads).toHaveLength(0);
        expect(authorizations).toEqual(['Bearer instance-token', 'Bearer instance-token']);
      } finally {
        client.disconnect();
        for (const socket of signaling.clients) socket.terminate();
        await new Promise<void>((resolve) => signaling.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
