import Limrun from '@limrun/api';

const instance = {
  metadata: { id: 'macos_eu_01h', organizationId: 'org', createdAt: '2026-11-23T00:00:00Z' },
  spec: { region: 'eu-north1', inactivityTimeout: '3m' },
  status: {
    state: 'ready',
    endpointWebSocketUrl: 'wss://node.example/v1/macos_eu_01h/endpointWebSocket',
    streamToken: 'stream',
  },
};

test('macOS instances use their own routes, query params and conditional update', async () => {
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  const client = new Limrun({
    apiKey: 'key',
    baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (method === 'DELETE' || method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'GET' && url.pathname === '/v1/macos_instances') {
        // One page: the request for the page after it gets nothing.
        return Response.json(url.searchParams.has('startingAfter') ? [] : [instance]);
      }
      return Response.json(instance);
    },
  });

  const created = await client.macosInstances.create({
    wait: true,
    metadata: { labels: { env: 'test' } },
    spec: { inactivityTimeout: '5m', jurisdiction: 'eu' },
  });
  expect(created.status.endpointWebSocketUrl).toBe(instance.status.endpointWebSocketUrl);

  const listed = [];
  for await (const item of client.macosInstances.list({ state: 'ready', labelSelector: 'env=test' })) {
    listed.push(item.metadata.id);
  }
  expect(listed).toEqual(['macos_eu_01h']);

  await client.macosInstances.get('macos_eu_01h');
  await client.macosInstances.update('macos_eu_01h', { ifMatch: '"v1"', metadata: { labels: {} } });
  await client.macosInstances.delete('macos_eu_01h');

  expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
    'POST /v1/macos_instances',
    'GET /v1/macos_instances',
    'GET /v1/macos_instances',
    'GET /v1/macos_instances/macos_eu_01h',
    'PATCH /v1/macos_instances/macos_eu_01h',
    'DELETE /v1/macos_instances/macos_eu_01h',
  ]);
  expect(calls[0]!.url.searchParams.get('wait')).toBe('true');
  expect(calls[0]!.body).toEqual({
    metadata: { labels: { env: 'test' } },
    spec: { inactivityTimeout: '5m', jurisdiction: 'eu' },
  });
  expect(calls[1]!.url.searchParams.get('state')).toBe('ready');
  expect(calls[1]!.url.searchParams.get('labelSelector')).toBe('env=test');
  expect(calls[2]!.url.searchParams.get('startingAfter')).toBe('macos_eu_01h');
  expect(calls[4]!.headers.get('if-match')).toBe('"v1"');
  expect(calls[4]!.body).toEqual({ metadata: { labels: {} } });
});

describe('macOS client', () => {
  let server: import('http').Server;
  let apiUrl: string;
  const requests: Array<{ method: string; path: string; auth?: string; body: unknown }> = [];

  beforeAll(async () => {
    const http = await import('http');
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        requests.push({
          method: req.method!,
          path: req.url!,
          ...(req.headers.authorization && { auth: req.headers.authorization }),
          body,
        });
        if (req.url === '/exec') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ execId: 'run-1' }));
        } else if (req.url!.startsWith('/exec/run-1/events')) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.end(
            'id: 0\nevent: command\ndata: sw_vers\n\n' +
              'id: 1\nevent: stdout\ndata: 27.2.1\n\n' +
              'id: 2\nevent: exitCode\ndata: 0\n\n',
          );
        } else if (req.url === '/snapshot') {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write('event: snapshot\ndata: {"phase":"resolving"}\n\n');
          res.write(': keepalive\n\n');
          res.write('event: snapshot\ndata: {"phase":"downloading","totalBytes":10,"doneBytes":4}\n\n');
          res.end('event: snapshot\ndata: {"phase":"restored","key":"my-mac","matchKind":"exact_hit"}\n\n');
        } else if (req.url === '/ssh') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ user: 'limrun', port: 22 }));
        } else if (req.url === '/recordings') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ recordingId: 'rec-1', captureId: 'rec-123' }));
        } else if (req.url === '/recordings/stop' || req.url === '/recordings/rec-1/stop') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ recordingId: 'rec-1' }));
        } else if (req.url!.startsWith('/files?')) {
          res.setHeader('Content-Type', 'video/mp4');
          res.end(Buffer.from('mp4'));
        } else if (req.url!.startsWith('/app-logs?')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ bundleId: 'com.apple.TextEdit', logs: 'one\ntwo' }));
        } else if (req.url === '/apps/launch') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ bundleId: 'com.example.app', pid: 42, launched: true }));
        } else if (req.url === '/apps/terminate' && raw.includes('com.missing')) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: 'no app com.missing is installed' }));
        } else if (req.url === '/trusted-cas') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ sha256: 'ab'.repeat(32) }));
        } else if (req.url === '/screenshot.jpg') {
          res.setHeader('Content-Type', 'image/jpeg');
          res.end(Buffer.from([0xff, 0xd8, 0xff]));
        } else {
          res.statusCode = 204;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('net').AddressInfo;
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('runs commands, sets up SSH and drives the screen through the guest API', async () => {
    const limrun = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const mac = await limrun.macosInstances.createClient({ apiUrl, token: 'control', logLevel: 'none' });

    const lines: string[] = [];
    const proc = mac.run('sw_vers', { cwd: 'Desktop', env: ['A=b'], timeoutSeconds: 30 });
    proc.stdout.on('data', (line: string) => lines.push(line));
    const result = await proc;
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['27.2.1']);

    expect(await mac.enableSsh('ssh-ed25519 AAAA test')).toEqual({ user: 'limrun', port: 22 });
    expect([...(await mac.screenshot())]).toEqual([0xff, 0xd8, 0xff]);
    await mac.tap({ x: 10, y: 20 }, { button: 'right' });
    await mac.typeText('hi');
    await mac.pressKey('q', ['command']);
    await mac.scroll({ dy: 300, at: { x: 5, y: 6 } });
    await mac.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { durationMs: 100 });
    const progress: string[] = [];
    const restored = await mac.restoreSnapshot({
      key: 'my-mac',
      restoreKeys: ['my-mac', 'base-'],
      onProgress: (p) => progress.push(p.phase),
    });
    expect(restored).toEqual({ phase: 'restored', key: 'my-mac', matchKind: 'exact_hit' });
    expect(progress).toEqual(['resolving', 'downloading', 'restored']);

    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts.every((r) => r.auth === 'Bearer control')).toBe(true);
    expect(posts.map((r) => [r.path, r.body])).toEqual([
      ['/exec', { command: 'run', commandLine: 'sw_vers', cwd: 'Desktop', env: ['A=b'], timeoutSeconds: 30 }],
      ['/ssh', { publicKey: 'ssh-ed25519 AAAA test' }],
      ['/tap', { x: 10, y: 20, button: 'right' }],
      ['/type', { text: 'hi' }],
      ['/press-key', { key: 'q', modifiers: ['command'] }],
      ['/scroll', { dx: 0, dy: 300, x: 5, y: 6 }],
      ['/drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 100 }],
      ['/snapshot', { key: 'my-mac', restoreKeys: ['my-mac', 'base-'] }],
    ]);
  });

  test('records the screen, captures logs, events and performance, and trusts CAs', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const pathModule = await import('path');
    const limrun = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const mac = await limrun.macosInstances.createClient({ apiUrl, token: 'control', logLevel: 'none' });
    requests.length = 0;

    expect(await mac.startRecording({ quality: 7, persist: { ttlSeconds: 600 } })).toBe('rec-1');
    const localPath = pathModule.join(fs.mkdtempSync(pathModule.join(os.tmpdir(), 'mac-rec-')), 'out.mp4');
    const url = await mac.stopRecording(undefined, { localPath });
    expect(url).toBe(`${apiUrl}/files?name=recording_rec-1.mp4`);
    expect(fs.readFileSync(localPath, 'utf8')).toBe('mp4');
    await mac.stopRecording('rec-1');
    await expect(mac.stopRecording('Not Valid')).rejects.toThrow('recordingId must match');

    expect(
      await mac.launchApp('Example', { mode: 'RelaunchIfRunning', arguments: ['-v'], env: { A: 'b' } }),
    ).toEqual({ bundleId: 'com.example.app', pid: 42, launched: true });
    await mac.terminateApp('com.example.app');
    await expect(mac.terminateApp('com.missing')).rejects.toThrow(
      'POST /apps/terminate failed: 404 no app com.missing is installed',
    );
    expect(await mac.appLogTail('com.apple.TextEdit', 50)).toBe('one\ntwo');
    await mac.startAppLogCapture({ bundleId: 'com.apple.TextEdit', persist: true });
    await mac.stopAppLogCapture();
    await mac.startEventCapture();
    await mac.stopEventCapture();
    await mac.startPerformanceCapture({ ttlSeconds: 3600 });
    await mac.stopPerformanceCapture();
    expect(await mac.addCaCertificate('-----BEGIN CERTIFICATE-----')).toEqual({ sha256: 'ab'.repeat(32) });

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/recordings', { quality: 7, persist: true, ttlSeconds: 600 }],
      ['POST', '/recordings/stop', {}],
      ['GET', '/files?name=recording_rec-1.mp4', undefined],
      ['POST', '/recordings/rec-1/stop', {}],
      [
        'POST',
        '/apps/launch',
        { app: 'Example', mode: 'RelaunchIfRunning', arguments: ['-v'], env: { A: 'b' } },
      ],
      ['POST', '/apps/terminate', { bundleId: 'com.example.app' }],
      ['POST', '/apps/terminate', { bundleId: 'com.missing' }],
      ['GET', '/app-logs?bundleId=com.apple.TextEdit&lines=50', undefined],
      ['POST', '/session/applogs/start', { bundleId: 'com.apple.TextEdit', persist: true }],
      ['POST', '/session/applogs/stop', {}],
      ['POST', '/session/events/start', {}],
      ['POST', '/session/events/stop', {}],
      ['POST', '/session/performance/start', { ttlSeconds: 3600 }],
      ['POST', '/session/performance/stop', {}],
      ['POST', '/trusted-cas', '-----BEGIN CERTIFICATE-----'],
    ]);
    expect(requests.every((r) => r.auth === 'Bearer control')).toBe(true);
  });
});

test('macOS session artifacts are listed by kind', async () => {
  const urls: string[] = [];
  const client = new Limrun({
    apiKey: 'key',
    baseURL: 'https://api.example.test',
    fetch: async (input) => {
      urls.push(new URL(input.toString()).pathname + new URL(input.toString()).search);
      return Response.json([]);
    },
  });
  await client.macosInstances.listRecordings('macos_eu_01h');
  await client.macosInstances.listAppLogs('macos_eu_01h');
  await client.macosInstances.listEvents('macos_eu_01h');
  await client.macosInstances.listPerformanceCaptures('macos_eu_01h');
  await client.macosInstances.listSessionArtifacts('macos_eu_01h');
  expect(urls).toEqual([
    '/v1/macos_instances/macos_eu_01h/session_artifacts?kind=recording',
    '/v1/macos_instances/macos_eu_01h/session_artifacts?kind=appLog',
    '/v1/macos_instances/macos_eu_01h/session_artifacts?kind=eventLog',
    '/v1/macos_instances/macos_eu_01h/session_artifacts?kind=performance',
    '/v1/macos_instances/macos_eu_01h/session_artifacts',
  ]);
});

test('a macOS tunnel dials the instance with its token and inspects as iOS and Android do', async () => {
  const { WebSocketServer } = await import('ws');
  const { destinationTunnelConfigHash, normalizeDestinationTunnelInspection } = await import(
    '../src/destination-tunnel'
  );
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => relay.once('listening', () => resolve()));
  const port = (relay.address() as import('net').AddressInfo).port;
  const seen: Array<{ path: string; auth?: string; start: Record<string, unknown> }> = [];
  relay.on('connection', (ws, req) => {
    ws.once('message', (data) => {
      const start = JSON.parse(data.toString()) as Record<string, unknown>;
      seen.push({
        path: req.url!,
        ...(req.headers.authorization && { auth: req.headers.authorization }),
        start,
      });
      ws.send(
        JSON.stringify({
          type: 'ready',
          version: 1,
          tunnelId: 'tun-1',
          configHash: destinationTunnelConfigHash(
            ['localhost:3000'],
            normalizeDestinationTunnelInspection({ enabled: true, captureBodies: false }),
          ),
          selectors: [{ id: 'selector-1', kind: 'route', value: 'localhost:3000' }],
        }),
      );
    });
  });
  try {
    const limrun = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const mac = await limrun.macosInstances.createClient({
      apiUrl: `http://127.0.0.1:${port}/v1/macos_eu_01h/api`,
      token: 'control',
      logLevel: 'none',
    });
    const tunnel = await mac.startTunnel({ selectors: ['localhost:3000'], resetsInactivityTimeout: false });
    expect(tunnel.tunnelId).toBe('tun-1');
    tunnel.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/v1/macos_eu_01h/api/tunnel');
    expect(seen[0]!.auth).toBe('Bearer control');
    expect(seen[0]!.start).toMatchObject({
      type: 'start',
      selectors: ['localhost:3000'],
      resetsInactivityTimeout: false,
      inspection: { enabled: true, captureBodies: false },
    });
  } finally {
    for (const client of relay.clients) client.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});

test('macOS snapshots are assets listed by kind, with the build they restore onto', async () => {
  const calls: URL[] = [];
  const asset = {
    id: 'asset_1',
    kind: 'MacOSSnapshot',
    name: 'my-mac',
    sha256: 'ab',
    sizeBytes: 10,
    publishedAt: '2026-11-23T00:00:00Z',
    metadata: { compatKey: 'macos-27.2.1', format: 'aar', uncompressedSizeBytes: 20 },
  };
  const client = new Limrun({
    apiKey: 'key',
    baseURL: 'https://api.example.test',
    fetch: async (input) => {
      calls.push(new URL(input.toString()));
      return Response.json([asset]);
    },
  });
  const listed = await client.assets.list({ kindFilter: 'MacOSSnapshot', namePrefixFilter: 'my-' });
  expect(listed[0]!.metadata?.compatKey).toBe('macos-27.2.1');
  expect(calls[0]!.pathname).toBe('/v1/assets');
  expect(calls[0]!.searchParams.get('kindFilter')).toBe('MacOSSnapshot');
  expect(calls[0]!.searchParams.get('namePrefixFilter')).toBe('my-');
});
