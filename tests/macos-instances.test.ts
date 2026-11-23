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
        requests.push({
          method: req.method!,
          path: req.url!,
          ...(req.headers.authorization && { auth: req.headers.authorization }),
          body: raw ? JSON.parse(raw) : undefined,
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
        } else if (req.url === '/ssh') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ user: 'limrun', port: 22 }));
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
    ]);
  });
});

test('macOS snapshots use the instance and organization snapshot routes', async () => {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const snapshot = { config: { key: 'my-mac' }, restore: { phase: 'restored' }, save: { phase: 'idle' } };
  const client = new Limrun({
    apiKey: 'key',
    baseURL: 'https://api.example.test',
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/macos_snapshots')) return Response.json({ snapshots: [] });
      if (url.pathname.includes('/macos_snapshots/')) return Response.json({ key: 'my-mac' });
      return Response.json(snapshot);
    },
  });

  expect(await client.macosInstances.getSnapshot('macos_eu_01h')).toEqual(snapshot);
  await client.macosInstances.bindSnapshotKey('macos_eu_01h', 'my-mac');
  await client.macosSnapshots.list('org_1', { prefix: 'my-' });
  await client.macosSnapshots.get('org_1', 'my-mac');
  await client.macosSnapshots.delete('org_1', 'my-mac');

  expect(calls).toEqual([
    'GET /v1/macos_instances/macos_eu_01h/snapshot',
    'PUT /v1/macos_instances/macos_eu_01h/snapshot',
    'GET /v1/organizations/org_1/macos_snapshots?prefix=my-',
    'GET /v1/organizations/org_1/macos_snapshots/my-mac',
    'DELETE /v1/organizations/org_1/macos_snapshots/my-mac',
  ]);
  expect(bodies[1]).toEqual({ key: 'my-mac' });
});
