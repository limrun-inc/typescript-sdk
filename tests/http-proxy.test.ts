import http from 'http';
import { startForwardHttpProxy, type HttpProxy } from '@limrun/api';

type ReceivedRequest = {
  url: string;
  headers: http.IncomingHttpHeaders;
};

// Stands in for the remote runner (and for a target the proxy must refuse):
// records the request and answers with a marker body.
function startRecordingServer(marker: string): Promise<{
  port: number;
  requests: ReceivedRequest[];
  close: () => Promise<void>;
}> {
  const requests: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, {
      'content-type': 'text/plain',
      // A hop-by-hop response header the proxy must not forward.
      'proxy-authenticate': 'Basic realm="upstream"',
    });
    res.end(marker);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('listen failed'));
        return;
      }
      resolve({
        port: address.port,
        requests,
        close: () => new Promise((res2, rej) => server.close((err) => (err ? rej(err) : res2()))),
      });
    });
  });
}

// Sends an absolute-form request through the proxy, the way HTTP clients
// configured with a forward proxy (e.g. JVM -Dhttp.proxyHost) do.
function requestViaProxy(
  proxyPort: number,
  absoluteUrl: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: absoluteUrl, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startForwardHttpProxy', () => {
  let remote: Awaited<ReturnType<typeof startRecordingServer>>;
  let other: Awaited<ReturnType<typeof startRecordingServer>>;
  let proxy: HttpProxy;
  const matchPort = 47001;

  beforeAll(async () => {
    [remote, other] = await Promise.all([
      startRecordingServer('remote-runner'),
      startRecordingServer('other-target'),
    ]);
    proxy = await startForwardHttpProxy({
      matchPort,
      remoteBaseUrl: `http://127.0.0.1:${remote.port}/base`,
      headers: { authorization: 'Bearer test-token' },
    });
  });

  beforeEach(() => {
    remote.requests.length = 0;
    other.requests.length = 0;
  });

  afterAll(async () => {
    await proxy.close();
    await remote.close();
    await other.close();
  });

  test('rewrites loopback requests on matchPort to the remote base URL with injected headers', async () => {
    const response = await requestViaProxy(proxy.port, `http://127.0.0.1:${matchPort}/status?x=1`, {
      'proxy-connection': 'keep-alive',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('remote-runner');

    const received = remote.requests[0]!;
    expect(received.url).toBe('/base/status?x=1');
    expect(received.headers['authorization']).toBe('Bearer test-token');
    // Hop-by-hop headers must not leak in either direction.
    expect(received.headers['proxy-connection']).toBeUndefined();
    expect(response.headers['proxy-authenticate']).toBeUndefined();
  });

  test('matches localhost as loopback', async () => {
    const response = await requestViaProxy(proxy.port, `http://localhost:${matchPort}/deviceInfo`);
    expect(response.status).toBe(200);
    expect(response.body).toBe('remote-runner');
    expect(remote.requests[0]!.url).toBe('/base/deviceInfo');
  });

  test('refuses loopback targets on other ports instead of forwarding them', async () => {
    const response = await requestViaProxy(proxy.port, `http://127.0.0.1:${other.port}/other`);
    expect(response.status).toBe(403);
    // The proxy has exactly one destination, so nothing reaches the other server.
    expect(other.requests).toHaveLength(0);
  });

  test('rejects origin-form request targets', async () => {
    const response = await requestViaProxy(proxy.port, '/not-absolute');
    expect(response.status).toBe(400);
  });

  test('refuses non-loopback targets, including on the matched port', async () => {
    expect((await requestViaProxy(proxy.port, 'http://example.com/anything')).status).toBe(403);
    expect((await requestViaProxy(proxy.port, `http://example.com:${matchPort}/status`)).status).toBe(403);
  });
});
