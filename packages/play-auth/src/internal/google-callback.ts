export async function openGoogleCallback(state: string, timeoutMs = 5 * 60 * 1000, signal?: AbortSignal) {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('Desktop OAuth requires a Node.js process. Use requestGoogleAccessToken in a browser.');
  }
  const { createServer } = await import('node:http');
  signal?.throwIfAborted();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The browser opener can still be pending when cancellation or timeout arrives.
  void code.catch(() => {});
  let completed = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      response.writeHead(400).end('Invalid callback URL.');
      return;
    }
    if (
      request.headers.host !== new URL(redirectUri).host ||
      request.method !== 'GET' ||
      url.pathname !== '/callback'
    ) {
      response.writeHead(404).end('Not found');
      return;
    }
    if (completed || url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid or expired sign-in request.');
      return;
    }
    const value = url.searchParams.get('code');
    if (url.searchParams.has('error') || !value) {
      completed = true;
      response.writeHead(400).end('Google sign-in was not completed. Return to your terminal.');
      rejectCode(new Error('Google sign-in was denied or cancelled.'));
      return;
    }
    completed = true;
    response.end('Google sign-in received. Return to your terminal to finish.');
    resolveCode(value);
  });
  let redirectUri = '';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Could not open Google sign-in callback.'));
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      resolve();
    });
  });
  const cancel = () => rejectCode(new Error('Google sign-in cancelled.'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => rejectCode(new Error('Google sign-in timed out. Start a new sign-in.')),
    timeoutMs,
  );
  return {
    redirectUri,
    code,
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      server.close();
      server.closeAllConnections();
    },
  };
}
