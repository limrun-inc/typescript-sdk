import http from 'http';
import net from 'net';

const CONSOLE_ENDPOINT = 'https://console.example.test';

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (typeof address !== 'object' || !address) {
        server.close();
        reject(new Error('Failed to allocate test port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function request(
  port: number,
  options: {
    agent?: http.Agent;
    headers?: http.OutgoingHttpHeaders;
    method?: string;
    path: string;
  },
): Promise<{ body: string; headers: http.IncomingHttpHeaders; statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent: options.agent,
        headers: options.headers,
        host: 'localhost',
        method: options.method ?? 'GET',
        path: options.path,
        port,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ body, headers: res.headers, statusCode: res.statusCode });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}


describe('lim login callback server', () => {
  test('writes the api key and resolves promptly after a keep-alive callback', async () => {
    const port = await getAvailablePort();
    const agent = new http.Agent({ keepAlive: true });
    const configWrites: Array<Partial<Record<string, string>>> = [];
    let hangingSocket: net.Socket | undefined;
    let hangingSocketClosed: Promise<void> = Promise.resolve();
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    try {
      const loginPromise = loginWithOptions({
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        callbackPort: port,
        configWriter: (partial) => {
          configWrites.push(partial);
        },
        opener: () => {
          hangingSocket = net.createConnection({ host: 'localhost', port });
          hangingSocketClosed = new Promise((resolve) => {
            hangingSocket?.on('close', () => resolve());
          });
          void request(port, { agent, path: '/authn/callback?api-key=lim_test_key' }).catch(() => {});
        },
        timeoutMs: 1_000,
      });

      const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 500));
      await expect(Promise.race([loginPromise.then(() => 'resolved'), timeout])).resolves.toBe('resolved');
      await expect(Promise.race([hangingSocketClosed.then(() => 'closed'), timeout])).resolves.toBe('closed');
      expect(configWrites).toEqual([{ 'api-key': 'lim_test_key' }]);
    } finally {
      agent.destroy();
      hangingSocket?.destroy();
    }
  });

  test('allows browser private-network preflight before callback delivery', async () => {
    const port = await getAvailablePort();
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');
    let preflightHeaders: http.IncomingHttpHeaders | undefined;

    await loginWithOptions({
      consoleEndpoint: CONSOLE_ENDPOINT,
      version: 'test',
      callbackPort: port,
      configWriter: () => {},
      opener: () => {
        void (async () => {
          const preflight = await request(port, {
            headers: {
              Origin: 'https://console.limrun.com',
              'Access-Control-Request-Method': 'GET',
              'Access-Control-Request-Private-Network': 'true',
            },
            method: 'OPTIONS',
            path: '/authn/callback?api-key=lim_test_key',
          });
          preflightHeaders = preflight.headers;
          await request(port, { path: '/authn/callback?api-key=lim_test_key' });
        })().catch(() => {});
      },
      timeoutMs: 1_000,
    });

    expect(preflightHeaders?.['access-control-allow-private-network']).toBe('true');
    expect(preflightHeaders?.connection).toBe('close');
  });

  test('rejects when the browser never calls back', async () => {
    const port = await getAvailablePort();
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    await expect(
      loginWithOptions({
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        callbackPort: port,
        configWriter: () => {},
        opener: () => undefined,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('Login timed out waiting for browser authorization');
  });

  test('rejects cleanly when saving the api key fails', async () => {
    const port = await getAvailablePort();
    const { loginWithOptions } = await import('../packages/cli/src/lib/auth');

    await expect(
      loginWithOptions({
        consoleEndpoint: CONSOLE_ENDPOINT,
        version: 'test',
        callbackPort: port,
        configWriter: () => {
          throw new Error('disk full');
        },
        opener: () => {
          void request(port, { path: '/authn/callback?api-key=lim_test_key' }).catch(() => {});
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('disk full');
  });
});
