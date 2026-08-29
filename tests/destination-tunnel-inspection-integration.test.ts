import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
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

function inspectionBodyEnvelope(
  sequence: number,
  requestId: string,
  direction: 'request' | 'response',
  body: string,
): unknown {
  return {
    sequence,
    type: 'body',
    requestId,
    data: {
      direction,
      encoding: 'base64',
      chunk: Buffer.from(body).toString('base64'),
    },
  };
}

function writeSSE(response: http.ServerResponse, id: number, data: unknown, retry?: number): void {
  if (retry !== undefined) response.write(`retry: ${retry}\n`);
  response.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

describe('destination tunnel inspection integration', () => {
  test('isolates inspection failures and closes its socket with the main tunnel', async () => {
    const inspectionRequests: string[] = [];
    let inspectionClosed = false;
    const server = http.createServer((request, response) => {
      inspectionRequests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('id: 1\ndata: {not-json\n\n');
      inspectionClosed = true;
    });
    const main = new WebSocketServer({ noServer: true });
    const authorizations: Array<string | undefined> = [];
    server.on('upgrade', (request, socket, head) => {
      main.handleUpgrade(request, socket, head, (webSocket) => {
        main.emit('connection', webSocket, request);
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
            selectors: [],
            configHash: destinationTunnelConfigHash(start.selectors, start.inspection),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const errors: Error[] = [];
    const tunnel = await startDestinationTcpTunnel(
      `ws://127.0.0.1:${address.port}/tunnel`,
      'same-instance-token',
      {
        selectors: ['127.0.0.1:8080'],
        inspection: { enabled: true, captureBodies: false },
        onInspectionError: (error) => errors.push(error),
        logLevel: 'none',
      },
    );
    try {
      await waitFor(() => errors.length > 0 && inspectionClosed);
      expect(tunnel.getConnectionState()).toBe('connected');
      expect(authorizations).toEqual(['Bearer same-instance-token']);
      expect(inspectionRequests).toEqual(['/tunnel/tunnel-1/inspection/events?token=same-instance-token']);
    } finally {
      tunnel.close();
      for (const socket of main.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => main.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    }
  });

  test('keeps body and complete events ordered across inspection reconnect and replay', async () => {
    const inspectionURLs: string[] = [];
    const inspectionLastEventIDs: Array<string | undefined> = [];
    const events: DestinationTunnelInspectionEvent[] = [];
    let inspectionConnections = 0;
    const server = http.createServer((request, response) => {
      inspectionConnections++;
      inspectionURLs.push(request.url ?? '');
      const lastEventId = request.headers['last-event-id'];
      inspectionLastEventIDs.push(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (inspectionConnections === 1) {
        writeSSE(response, 1, inspectionBodyEnvelope(1, 'request-1', 'request', 'one'), 10);
        response.end();
        return;
      }
      writeSSE(response, 2, inspectionBodyEnvelope(2, 'request-1', 'response', 'two'));
      writeSSE(response, 3, {
        sequence: 3,
        type: 'complete',
        requestId: 'request-1',
        data: completeEntry(),
      });
    });
    const main = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      main.handleUpgrade(request, socket, head, (webSocket) => {
        main.emit('connection', webSocket, request);
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
            selectors: [],
            configHash: destinationTunnelConfigHash(start.selectors, start.inspection),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as net.AddressInfo;
    const tunnel = await startDestinationTcpTunnel(
      `ws://127.0.0.1:${address.port}/tunnel`,
      'same-instance-token',
      {
        selectors: ['127.0.0.1:8080'],
        inspection: { enabled: true, captureBodies: true },
        onInspectionEvent: (event) => events.push(event),
        logLevel: 'none',
      },
    );
    try {
      await waitFor(() => events.some((event) => event.type === 'complete'));
      expect(inspectionURLs).toEqual([
        '/tunnel/tunnel-1/inspection/events?token=same-instance-token',
        '/tunnel/tunnel-1/inspection/events?token=same-instance-token',
      ]);
      expect(inspectionLastEventIDs).toEqual([undefined, '1']);
      expect(events.map((event) => [event.type, event.sequence])).toEqual([
        ['body', 1],
        ['body', 2],
        ['complete', 3],
      ]);
      expect(events[0]).toMatchObject({ requestId: 'request-1', direction: 'request' });
      expect(events[1]).toMatchObject({ requestId: 'request-1', direction: 'response' });
      expect(events[2]).toMatchObject({
        requestId: 'request-1',
        data: { _limrun: { tunnelId: 'tunnel-1', selectorId: 'selector-1' } },
      });
    } finally {
      tunnel.close();
      for (const socket of main.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => main.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    }
  });
});

function completeEntry() {
  return {
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
    _limrun: { tunnelId: 'tunnel-1', selectorId: 'selector-1' },
  };
}
