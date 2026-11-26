import http from 'http';
import { LogStream } from '../src/log-stream';

// The iOS client's streamAppLog returns this stream; macOS wraps it in its handlers.
test('an app log stream follows the instance server-sent events until they end', async () => {
  const seen: Array<{ url: string; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url!, ...(req.headers.authorization && { auth: req.headers.authorization }) });
    if (req.url!.includes('missing')) {
      res.statusCode = 404;
      res.end('{"message":"not installed"}');
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(': keepalive\n\n');
    res.write('data: one\n\n');
    res.end('data: two\r\ndata: lines\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/v1/ios_x/api/`;
  try {
    const stream = new LogStream({ apiUrl, token: 't', bundleId: 'com.example.app' });
    const lines: string[] = [];
    const batches: string[][] = [];
    stream.on('line', (line) => lines.push(line));
    stream.on('lines', (batch) => batches.push(batch));
    await new Promise<void>((resolve) => stream.on('close', resolve));
    expect(lines).toEqual(['one', 'two\nlines']);
    expect(batches).toEqual([['one'], ['two\nlines']]);

    const refused = new LogStream({ apiUrl, token: 't', bundleId: 'com.missing' });
    const error = await new Promise<Error>((resolve) => refused.on('error', resolve));
    expect(error.message).toBe('GET /app-logs/stream failed: 404 not installed');

    expect(seen).toEqual([
      { url: '/v1/ios_x/api/app-logs/stream?bundleId=com.example.app', auth: 'Bearer t' },
      { url: '/v1/ios_x/api/app-logs/stream?bundleId=com.missing', auth: 'Bearer t' },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('stopping an app log stream emits no error', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: one\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  try {
    const stream = new LogStream({ apiUrl, token: 't', bundleId: 'com.example.app' });
    const errors: Error[] = [];
    stream.on('error', (e) => errors.push(e));
    await new Promise<void>((resolve) => stream.once('line', () => resolve()));
    const closed = new Promise<void>((resolve) => stream.on('close', resolve));
    stream.stop();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
