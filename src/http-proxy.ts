import http from 'http';
import https from 'https';

export type HttpProxy = {
  port: number;
  close: () => Promise<void>;
};

export type StartHttpProxyOptions = {
  localPort?: number;
  remoteBaseUrl: string;
  headers?: Record<string, string>;
};

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
