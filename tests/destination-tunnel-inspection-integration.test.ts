import http from 'http';
import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { startDestinationTcpTunnel } from '../src/destination-tunnel-dialer';
import {
  DESTINATION_TUNNEL_VERSION,
  destinationTunnelConfigHash,
  type DestinationTunnelClientMessage,
} from '../src/destination-tunnel';
import type { DestinationTunnelInspectionEvent } from '../src/destination-tunnel-inspection';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function inspectionBodyFrame(
  sequence: number,
  requestId: string,
  direction: 'request' | 'response',
  body: string,
): Buffer {
  const id = Buffer.from(requestId);
  const payload = Buffer.from(body);
  const frame = Buffer.alloc(12 + id.length + payload.length);
  frame[0] = 1;
  frame.writeBigUInt64BE(BigInt(sequence), 1);
  frame.writeUInt16BE(id.length, 9);
  frame[11] = direction === 'request' ? 1 : 2;
  id.copy(frame, 12);
  payload.copy(frame, 12 + id.length);
  return frame;
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
      socket.once('message', (raw) => {
        const start = JSON.parse(raw.toString()) as DestinationTunnelClientMessage;
        if (start.type !== 'start') throw new Error('expected START');
        socket.send(
          JSON.stringify({
            type: 'ready',
            version: DESTINATION_TUNNEL_VERSION,
            tunnelId: 'tunnel-1',
            configHash: destinationTunnelConfigHash(
              {
                ...(start.routes ? { routes: start.routes } : {}),
                ...(start.domains ? { domains: start.domains } : {}),
              },
              start.inspection,
            ),
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

  test('keeps body and complete events ordered across inspection reconnect and replay', async () => {
    const server = http.createServer();
    const main = new WebSocketServer({ noServer: true });
    const inspection = new WebSocketServer({ noServer: true });
    const inspectionURLs: string[] = [];
    const events: DestinationTunnelInspectionEvent[] = [];
    let inspectionConnections = 0;
    server.on('upgrade', (request, socket, head) => {
      const target = request.url?.includes('/inspection') ? inspection : main;
      target.handleUpgrade(request, socket, head, (webSocket) => {
        target.emit('connection', webSocket, request);
      });
    });
    main.on('connection', (socket) => {
      socket.once('message', (raw) => {
        const start = JSON.parse(raw.toString()) as DestinationTunnelClientMessage;
        if (start.type !== 'start') throw new Error('expected START');
        socket.send(
          JSON.stringify({
            type: 'ready',
            version: DESTINATION_TUNNEL_VERSION,
            tunnelId: 'tunnel-1',
            configHash: destinationTunnelConfigHash(
              {
                ...(start.routes ? { routes: start.routes } : {}),
                ...(start.domains ? { domains: start.domains } : {}),
              },
              start.inspection,
            ),
          }),
        );
      });
    });
    inspection.on('connection', (socket, request) => {
      inspectionConnections++;
      inspectionURLs.push(request.url ?? '');
      if (inspectionConnections === 1) {
        socket.send(inspectionBodyFrame(1, 'request-1', 'request', 'one'));
        socket.close();
        return;
      }
      socket.send(inspectionBodyFrame(2, 'request-1', 'response', 'two'));
      socket.send(
        JSON.stringify({
          sequence: 3,
          type: 'complete',
          requestId: 'request-1',
          data: {
            startedDateTime: new Date().toISOString(),
            time: 2,
            request: {
              method: 'POST',
              url: 'https://example.com/path',
              httpVersion: 'HTTP/1.1',
              headers: [],
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: 3,
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              headers: [],
              cookies: [],
              content: { size: 3, mimeType: 'text/plain' },
              redirectURL: '',
              headersSize: -1,
              bodySize: 3,
            },
            cache: {},
            timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 1, receive: 1, ssl: -1 },
            _limrun: { tunnelId: 'tunnel-1', selectorId: 'route-1' },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const tunnel = await startDestinationTcpTunnel(
      `ws://127.0.0.1:${address.port}/tunnel`,
      'same-instance-token',
      {
        routes: [{ host: '127.0.0.1', port: 8080 }],
        inspection: { enabled: true, captureBodies: true },
        onInspectionEvent: (event) => events.push(event),
        logLevel: 'none',
      },
    );
    try {
      await waitFor(() => events.some((event) => event.type === 'complete'));
      expect(inspectionURLs).toEqual([
        '/tunnel/tunnel-1/inspection?after-sequence=0',
        '/tunnel/tunnel-1/inspection?after-sequence=1',
      ]);
      expect(events.map((event) => [event.type, event.sequence])).toEqual([
        ['body', 1],
        ['body', 2],
        ['complete', 3],
      ]);
      expect(events[0]).toMatchObject({ requestId: 'request-1', direction: 'request' });
      expect(events[1]).toMatchObject({ requestId: 'request-1', direction: 'response' });
      expect(events[2]).toMatchObject({
        requestId: 'request-1',
        data: { _limrun: { tunnelId: 'tunnel-1', selectorId: 'route-1' } },
      });
    } finally {
      tunnel.close();
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
