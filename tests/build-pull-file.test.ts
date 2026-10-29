import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import http from 'http';
import { createHash } from 'crypto';
import { once } from 'events';
import Limrun from '@limrun/api';

// Real HTTP exercises streaming, Content-Length validation, and partial-transfer cleanup.
describe.each(['xcode', 'gradle'] as const)('%s pullFile', (platform) => {
  let directory: string;
  let server: http.Server;
  let apiUrl: string;
  const chunk = Buffer.alloc(1024 * 1024, 0xa5);
  const expectedHash = createHash('sha256');
  for (let i = 0; i < 64; i++) expectedHash.update(chunk);
  const digest = expectedHash.digest('hex');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lim-pull-test-'));
    server = http.createServer(async (request, response) => {
      expect(request.method).toBe('GET');
      expect(request.headers.authorization).toBe('Bearer instance-token');
      const url = new URL(request.url!, 'http://localhost');
      expect(url.pathname).toBe('/files');
      const name = url.searchParams.get('path');
      if (name === 'missing') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'file not found' }));
      } else if (name === 'broken') {
        response.writeHead(200, { 'Content-Length': chunk.length * 2 });
        response.write(chunk);
        setTimeout(() => response.destroy(), 20);
      } else if (name === 'empty') {
        response.writeHead(200, { 'Content-Length': 0 });
        response.end();
      } else {
        expect(['artifacts/app #1.zip', '/tmp/app.zip', '../app.zip', 'links/app.zip']).toContain(name);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': 64 * chunk.length,
        });
        for (let i = 0; i < 64; i++) {
          if (!response.write(chunk)) await once(response, 'drain');
        }
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    apiUrl = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function client() {
    const api = new Limrun({ apiKey: 'key' });
    const resource = platform === 'xcode' ? api.xcodeInstances : api.gradleInstances;
    return resource.createClient({ apiUrl, token: 'instance-token' });
  }
  test.each(['artifacts/app #1.zip', '/tmp/app.zip', '../app.zip', 'links/app.zip'])(
    'downloads %s without changing binary bytes',
    async (remotePath) => {
      const destination = path.join(directory, 'app.zip');
      await (await client()).pullFile(remotePath, destination);
      const hash = createHash('sha256');
      for await (const bytes of (await import('fs')).createReadStream(destination)) hash.update(bytes);
      expect(hash.digest('hex')).toBe(digest);
      expect(await fs.readdir(directory)).toEqual(['app.zip']);
    },
  );
  test.each(['missing', 'broken'])('preserves destination after %s download', async (name) => {
    const destination = path.join(directory, 'app.zip');
    await fs.writeFile(destination, 'previous');
    await expect((await client()).pullFile(name, destination)).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['app.zip']);
  });
  test('replaces an existing destination with an empty file', async () => {
    const destination = path.join(directory, 'report');
    await fs.writeFile(destination, 'previous');
    await (await client()).pullFile('empty', destination);
    expect((await fs.stat(destination)).size).toBe(0);
  });
});
