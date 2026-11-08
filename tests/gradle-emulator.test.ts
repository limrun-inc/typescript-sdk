import http from 'http';
import type { AddressInfo } from 'net';
import Limrun from '../src';

test('Gradle attachment sends emulator credentials only to the build daemon', async () => {
  const calls: Array<{
    method: string | undefined;
    path: string | undefined;
    auth: string | undefined;
    body: string;
  }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ attached: req.method !== 'DELETE', installedLastBuild: req.method !== 'DELETE' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const lim = new Limrun({ apiKey: 'management-key' });
    const client = await lim.gradleInstances.createClient({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'gradle-token',
    });
    const result = await client.attachEmulator({ apiUrl: 'https://android.example', token: 'android-token' });
    expect(result.installedLastBuild).toBe(true);
    await client.getEmulator();
    expect(await client.detachEmulator()).toEqual({ attached: false, installedLastBuild: false });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/emulator',
        auth: 'Bearer gradle-token',
        body: JSON.stringify({ apiUrl: 'https://android.example', token: 'android-token' }),
      },
      { method: 'GET', path: '/emulator', auth: 'Bearer gradle-token', body: '' },
      { method: 'DELETE', path: '/emulator', auth: 'Bearer gradle-token', body: '' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
