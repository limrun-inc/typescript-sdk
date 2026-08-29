import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { nodeProxyTransport } from '../src/internal/proxy-transport';
import { testCa, testCertificate, testPrivateKey } from './fixtures/tls';

const proxyEnvironmentKeys = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

describe('TCP proxy transport', () => {
  const originalEnvironment = new Map<string, string | undefined>();
  const servers: Array<net.Server | http.Server | https.Server> = [];
  const sockets = new Set<net.Socket>();

  beforeAll(() => {
    for (const key of proxyEnvironmentKeys) originalEnvironment.set(key, process.env[key]);
  });

  beforeEach(() => {
    for (const key of proxyEnvironmentKeys) delete process.env[key];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map(closeServer));
  });

  afterAll(() => {
    for (const key of proxyEnvironmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('opens direct sockets when no proxy is configured', async () => {
    const originPort = await startOrigin('direct');

    const connection = await nodeProxyTransport.connectTcp({
      host: '127.0.0.1',
      port: originPort,
      proxyLookupProtocol: 'http:',
      timeoutMs: 1000,
    });
    sockets.add(connection.socket);

    expect(connection.remoteAddress).toBe('127.0.0.1');
    expect(await readBytes(connection.socket, 6)).toBe('direct');
  });

  test('uses the original hostname for NO_PROXY matching', async () => {
    const originPort = await startOrigin('bypass');
    let proxyConnections = 0;
    const proxyPort = await startConnectProxy(() => {
      proxyConnections++;
      return { status: 502 };
    });
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['HTTPS_PROXY'] = `http://127.0.0.1:${proxyPort}`;
    process.env['NO_PROXY'] = 'api.corp.example';

    const rawConnection = await nodeProxyTransport.connectTcp({
      host: '127.0.0.1',
      port: originPort,
      proxyLookupHost: 'api.corp.example',
      proxyLookupProtocol: 'http:',
      timeoutMs: 1000,
    });
    sockets.add(rawConnection.socket);
    const tlsConnection = await nodeProxyTransport.connectTcp({
      host: '127.0.0.1',
      port: originPort,
      proxyLookupHost: 'api.corp.example',
      proxyLookupProtocol: 'https:',
      timeoutMs: 1000,
    });
    sockets.add(tlsConnection.socket);

    expect(await readBytes(rawConnection.socket, 6)).toBe('bypass');
    expect(await readBytes(tlsConnection.socket, 6)).toBe('bypass');
    expect(proxyConnections).toBe(0);
  });

  test('tunnels raw TCP through an HTTP proxy with basic auth and preserves early bytes', async () => {
    const originPort = await startOrigin('origin');
    let authority = '';
    let authorization = '';
    const proxyPort = await startConnectProxy((request) => {
      authority = request.url ?? '';
      authorization = String(request.headers['proxy-authorization'] ?? '');
      return { status: 200, targetPort: originPort, earlyBytes: 'early-' };
    });
    process.env['HTTP_PROXY'] = `http://user:p%40ss@127.0.0.1:${proxyPort}`;

    const connection = await nodeProxyTransport.connectTcp({
      host: '127.0.0.1',
      port: originPort,
      proxyLookupHost: 'service.example',
      proxyLookupProtocol: 'http:',
      timeoutMs: 1000,
    });
    sockets.add(connection.socket);

    expect(authority).toBe(`127.0.0.1:${originPort}`);
    expect(authorization).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    expect(await readBytes(connection.socket, 12)).toBe('early-origin');
  });

  test('supports TLS-protected HTTP proxies', async () => {
    const originPort = await startOrigin('secure-proxy');
    const proxyPort = await startConnectProxy(() => ({ status: 200, targetPort: originPort }), { tls: true });
    process.env['HTTPS_PROXY'] = `https://localhost:${proxyPort}`;
    mockTlsTrust(testCa);

    const connection = await nodeProxyTransport.connectTcp({
      host: '127.0.0.1',
      port: originPort,
      proxyLookupHost: 'service.example',
      proxyLookupProtocol: 'https:',
      timeoutMs: 1000,
    });
    sockets.add(connection.socket);

    expect(await readBytes(connection.socket, 12)).toBe('secure-proxy');
  });

  test.each([
    [407, 'EPROXYAUTH'],
    [502, 'EPROXYCONNECT'],
  ])('reports proxy status %s with code %s', async (status, code) => {
    const proxyPort = await startConnectProxy(() => ({ status }));
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${proxyPort}`;

    await expect(
      nodeProxyTransport.connectTcp({
        host: '127.0.0.1',
        port: 443,
        proxyLookupHost: 'service.example',
        proxyLookupProtocol: 'http:',
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code });
  });

  test('bounds CONNECT response headers and times out stalled proxies', async () => {
    const oversizedProxyPort = await startConnectProxy(() => ({
      rawResponse: `HTTP/1.1 200 OK\r\nX-Large: ${'x'.repeat(70 * 1024)}`,
    }));
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${oversizedProxyPort}`;
    await expect(
      nodeProxyTransport.connectTcp({
        host: '127.0.0.1',
        port: 443,
        proxyLookupHost: 'large.example',
        proxyLookupProtocol: 'http:',
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'EPROXY' });

    const stalledProxyPort = await startConnectProxy(() => ({ rawResponse: '' }));
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${stalledProxyPort}`;
    await expect(
      nodeProxyTransport.connectTcp({
        host: '127.0.0.1',
        port: 443,
        proxyLookupHost: 'stalled.example',
        proxyLookupProtocol: 'http:',
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  async function startOrigin(greeting: string): Promise<number> {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      trackSocket(socket);
      socket.write(greeting);
      socket.on('data', (chunk) => socket.write(chunk));
    });
    servers.push(server);
    return listen(server);
  }

  async function startConnectProxy(
    response: (request: http.IncomingMessage) => {
      status?: number;
      targetPort?: number;
      earlyBytes?: string;
      rawResponse?: string;
    },
    options: { tls?: boolean } = {},
  ): Promise<number> {
    const server =
      options.tls ? https.createServer({ key: testPrivateKey, cert: testCertificate }) : http.createServer();
    server.on('connect', (request, clientSocket, head) => {
      trackSocket(clientSocket as net.Socket);
      const result = response(request);
      if (result.rawResponse !== undefined) {
        clientSocket.write(result.rawResponse);
        return;
      }
      const status = result.status ?? 200;
      if (status < 200 || status >= 300 || result.targetPort === undefined) {
        clientSocket.end(`HTTP/1.1 ${status} Proxy Error\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      const upstream = net.createConnection({ host: '127.0.0.1', port: result.targetPort }, () => {
        clientSocket.write(`HTTP/1.1 200 Connection Established\r\n\r\n${result.earlyBytes ?? ''}`);
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      trackSocket(upstream);
    });
    servers.push(server);
    return listen(server);
  }

  function trackSocket(socket: net.Socket): void {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }
});

function listen(server: net.Server | http.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function closeServer(server: net.Server | http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBytes(socket: net.Socket, expectedLength: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (received.length < expectedLength) return;
      cleanup();
      socket.pause();
      resolve(received.subarray(0, expectedLength).toString());
    };
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.resume();
  });
}

function mockTlsTrust(ca: string): void {
  const realConnect = tls.connect;
  jest
    .spyOn(tls, 'connect')
    .mockImplementation(((options: tls.ConnectionOptions) =>
      realConnect({ ...options, ca })) as typeof tls.connect);
}
