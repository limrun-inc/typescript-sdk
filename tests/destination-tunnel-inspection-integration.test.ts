import http from 'http';
import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { startDestinationTcpTunnel } from '../src/destination-tunnel-dialer';
import { DESTINATION_TUNNEL_VERSION } from '../src/destination-tunnel';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('destination tunnel inspection integration', () => {
  test('isolates inspection failures and closes its socket with the main tunnel', async () => {
    const server = http.createServer();
    const main = new WebSocketServer({ noServer: true });
    const inspection = new WebSocketServer({ noServer: true });
    const inspectionSockets = new Set<WebSocket>();
    const authorizations: Array<string | undefined> = [];
    let inspectionClosed = false;
    server.on('upgrade', (request, socket, head) => {
      const target = request.url?.includes('/inspection') ? inspection : main;
      target.handleUpgrade(request, socket, head, (webSocket) => {
        target.emit('connection', webSocket, request);
      });
    });
    main.on('connection', (socket, request) => {
      authorizations.push(request.headers.authorization);
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'ready',
            version: DESTINATION_TUNNEL_VERSION,
            tunnelId: 'tunnel-1',
            inspection: { enabled: true, captureBodies: false, maxBodyBytes: 10 * 1024 * 1024 },
          }),
        );
      });
    });
    inspection.on('connection', (socket, request) => {
      authorizations.push(request.headers.authorization);
      inspectionSockets.add(socket);
      socket.once('close', () => {
        inspectionSockets.delete(socket);
        inspectionClosed = true;
      });
      socket.send('{not-json');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const errors: Error[] = [];
    const tunnel = await startDestinationTcpTunnel(
      `ws://127.0.0.1:${address.port}/tunnel`,
      'same-instance-token',
      {
        routes: [{ host: '127.0.0.1', port: 8080 }],
        inspection: { enabled: true, captureBodies: false },
        onInspectionError: (error) => errors.push(error),
        logLevel: 'none',
      },
    );
    try {
      await waitFor(() => errors.length > 0 && inspectionClosed);
      expect(tunnel.getConnectionState()).toBe('connected');
      expect(authorizations).toEqual(['Bearer same-instance-token', 'Bearer same-instance-token']);
    } finally {
      tunnel.close();
      await waitFor(() => inspectionSockets.size === 0);
      for (const socket of main.clients) socket.terminate();
      for (const socket of inspection.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => main.close(() => resolve())),
        new Promise<void>((resolve) => inspection.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    }
  });
});
