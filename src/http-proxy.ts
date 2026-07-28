import http from 'http';
import https from 'https';
import { pipeline } from 'stream';

export type HttpProxy = {
  port: number;
  close: () => Promise<void>;
};

export type StartHttpProxyOptions = {
  localPort?: number;
  remoteBaseUrl: string;
  headers?: Record<string, string>;
};

/**
 * Legacy origin-form reverse proxy: forwards every request on the local port
 * to `remoteBaseUrl`. New callers should prefer `startForwardHttpProxy`.
 */
export async function startHttpProxy({
  localPort = 0,
  remoteBaseUrl,
  headers = {},
}: StartHttpProxyOptions): Promise<HttpProxy> {
  const base = trimTrailingSlashes(remoteBaseUrl);
  const server = http.createServer((req, res) => {
    const pathAndQuery = req.url || '/';
    const upstreamUrl = new URL(`${base}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`);
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    const upstream = transport.request(
      upstreamUrl,
      {
        method: req.method,
        headers: {
          ...req.headers,
          host: upstreamUrl.host,
          ...headers,
        },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(error.message);
    });
    req.pipe(upstream);
  });

  await listen(server, localPort);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start HTTP proxy.');
  }
  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

export type StartForwardHttpProxyOptions = {
  /** Loopback requests to this port are rewritten to remoteBaseUrl; everything else passes through. */
  matchPort: number;
  remoteBaseUrl: string;
  headers?: Record<string, string>;
};

// Hop-by-hop headers must not be forwarded by an HTTP proxy (RFC 9110 §7.6.1).
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

function withoutHopByHop(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name)));
}

/**
 * Standard HTTP forward proxy (absolute-form request targets, as sent by clients
 * configured with e.g. JVM -Dhttp.proxyHost) that rewrites loopback requests on
 * `matchPort` to `remoteBaseUrl` and passes every other target through untouched.
 */
export async function startForwardHttpProxy({
  matchPort,
  remoteBaseUrl,
  headers = {},
}: StartForwardHttpProxyOptions): Promise<HttpProxy> {
  const base = trimTrailingSlashes(remoteBaseUrl);
  // The driver polls the runner continuously, so upstream connections must be
  // reused instead of paying a TCP/TLS handshake per driver call.
  const agents = {
    'http:': new http.Agent({ keepAlive: true }),
    'https:': new https.Agent({ keepAlive: true }),
  };
  const server = http.createServer((req, res) => {
    let target: URL | undefined;
    try {
      target = new URL(req.url ?? '');
    } catch {
      // Falls through to the guard below.
    }
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Limrun forward proxy only accepts absolute-form request targets.');
      return;
    }

    // matchPort is always explicit (an ephemeral port or 7001), so a target
    // without a port can never match.
    const matched = isLoopbackHost(target.hostname) && Number(target.port) === matchPort;
    const upstreamUrl = matched ? new URL(`${base}${target.pathname}${target.search}`) : target;
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    const upstream = transport.request(
      upstreamUrl,
      {
        agent: agents[upstreamUrl.protocol as keyof typeof agents],
        method: req.method,
        headers: {
          ...withoutHopByHop(req.headers),
          host: upstreamUrl.host,
          ...(matched ? headers : {}),
        },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, withoutHopByHop(upstreamResponse.headers));
        // pipeline tears down whichever side is still alive when the other one
        // dies, instead of leaking it or raising an unhandled 'error'.
        pipeline(upstreamResponse, res, () => {});
      },
    );

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(error.message);
    });
    // A client that aborts mid-call must not leak the upstream socket.
    res.on('close', () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    pipeline(req, upstream, () => {});
  });

  // HTTPS clients open CONNECT tunnels; we deliberately keep TLS traffic off this
  // proxy (only http.proxyHost is set on the JVM side), so refuse loudly instead
  // of tunneling blind.
  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 501 Not Implemented\r\n\r\nLimrun forward proxy does not tunnel CONNECT.\r\n');
  });

  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start HTTP forward proxy.');
  }
  return {
    port: address.port,
    close: async () => {
      await closeServer(server);
      agents['http:'].destroy();
      agents['https:'].destroy();
    },
  };
}

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname keeps brackets around IPv6 hosts.
  return (
    hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
