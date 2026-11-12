import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createInstanceClient as createAndroidClient } from '../src/instance-client';
import { createInstanceClient as createIosClient } from '../src/ios-client';

describe.each(['android', 'ios'] as const)('%s asset name installation', (platform) => {
  test('sends names directly, preserves URL installs, and reports denied reads', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const requests: Record<string, any>[] = [];
    const signaling = new WebSocketServer({
      server,
      path: platform === 'ios' ? '/api/signaling' : '/api/ws',
    });
    signaling.on('connection', (socket) =>
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'deviceInfo') {
          socket.send(JSON.stringify({ type: 'deviceInfoResult', id: message.id, udid: 'simulator' }));
        }
        if (!['asset', 'appInstallation'].includes(message.type)) return;
        requests.push(message);
        const denied = message.assetName === 'denied.apk';
        socket.send(
          JSON.stringify({
            type: platform === 'ios' ? 'appInstallationResult' : 'assetResult',
            id: message.id,
            url: message.url,
            assetName: message.assetName,
            result: denied ? 'failure' : 'success',
            bundleId: 'com.example.app',
            ...(denied && { error: 'asset read denied', message: 'asset read denied' }),
          }),
        );
      }),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const client = await (platform === 'ios' ? createIosClient : createAndroidClient)({
      apiUrl,
      token: 'instance-token',
      logLevel: 'none',
    });
    try {
      const install = 'installApp' in client ? client.installApp : client.sendAsset;
      await install({ assetName: 'team/app:prod+版本.zip' });
      await install('https://storage.example/app.zip');
      await expect(install({ assetName: 'denied.apk' })).rejects.toThrow('asset read denied');
      expect(requests[0]).toMatchObject({ assetName: 'team/app:prod+版本.zip' });
      expect(requests[0]).not.toHaveProperty('url');
      expect(requests[1]).toMatchObject({ url: 'https://storage.example/app.zip' });
      expect(requests[1]).not.toHaveProperty('assetName');
      if (platform === 'android') expect(requests[0]!['id']).not.toBe(requests[2]!['id']);
    } finally {
      client.disconnect();
      for (const socket of signaling.clients) socket.terminate();
      await new Promise<void>((resolve) => signaling.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('Android correlates concurrent installs of the same name by request ID', async () => {
  const server = createServer();
  const signaling = new WebSocketServer({ server, path: '/api/ws' });
  signaling.on('connection', (socket) => {
    const installs: Array<{ id: string; assetName: string }> = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'asset') return;
      installs.push(message);
      if (installs.length !== 2) return;
      socket.send(JSON.stringify({ ...installs[1], type: 'assetResult', result: 'success' }));
      socket.send(
        JSON.stringify({ ...installs[0], type: 'assetResult', result: 'failure', message: 'first failed' }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = await createAndroidClient({
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
    token: 'instance-token',
    logLevel: 'none',
  });
  try {
    const first = client.sendAsset({ assetName: 'same.apk' }, 1000);
    const second = client.sendAsset({ assetName: 'same.apk' }, 1000);
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('first failed') });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
  } finally {
    client.disconnect();
    for (const socket of signaling.clients) socket.terminate();
    await new Promise<void>((resolve) => signaling.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
