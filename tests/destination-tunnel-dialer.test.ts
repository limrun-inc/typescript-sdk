import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  classifyOpenFailure,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
} from '../src/destination-tunnel-dialer';
import {
  DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES,
  DESTINATION_TUNNEL_VERSION,
  type DestinationTunnelClientMessage,
  type DestinationTunnelRoute,
  type DestinationTunnelServerMessage,
} from '../src/destination-tunnel';

type ClientEvent =
  | { kind: 'control'; message: DestinationTunnelClientMessage }
  | { kind: 'data'; connId: number; payload: Buffer };

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('destination tunnel dialer', () => {
  let remoteServer: WebSocketServer;
  let remoteSocket: WebSocket | undefined;
  let events: ClientEvent[];
  let tunnel: DestinationTcpTunnel | undefined;
  let localServers: net.Server[];
  let localSockets: Set<net.Socket>;

  beforeEach(async () => {
    events = [];
    localServers = [];
    localSockets = new Set();
    await startRemoteServer(true);
  });

  afterEach(async () => {
    tunnel?.close();
    tunnel = undefined;
    jest.restoreAllMocks();
    for (const socket of localSockets) socket.destroy();
    await Promise.all(
      localServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await closeRemoteServer();
  });

  test('sends OPEN-OK before server-first data and preserves directional FIN', async () => {
    let localSocket: net.Socket | undefined;
    let request = Buffer.alloc(0);
    const localPort = await listenLocal((socket) => {
      localSocket = socket;
      socket.write('greeting');
      socket.on('data', (data) => {
        request = Buffer.concat([request, data]);
      });
      socket.on('end', () => {
        socket.end('tail');
      });
    });
    const route = { host: '127.0.0.1', port: localPort };
    tunnel = await establish([route]);

    sendControl({
      type: 'open',
      connId: 7,
      routeId: 'route-1',
      host: route.host,
      port: route.port,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openOk', 7) && dataFor(7).toString() === 'greeting');
    const openIndex = events.findIndex(
      (event) => event.kind === 'control' && event.message.type === 'openOk',
    );
    const greetingIndex = events.findIndex(
      (event) => event.kind === 'data' && event.payload.toString() === 'greeting',
    );
    expect(greetingIndex).toBeGreaterThan(openIndex);

    sendData(7, Buffer.from('request'));
    await waitFor(() => request.toString() === 'request');

    sendControl({ type: 'fin', connId: 7 });
    await waitFor(() => dataFor(7).toString() === 'greetingtail' && hasControl('fin', 7));
    const finIndex = events.findIndex((event) => event.kind === 'control' && event.message.type === 'fin');
    const dataBeforeFin = Buffer.concat(
      events
        .slice(0, finIndex)
        .filter(
          (event): event is Extract<ClientEvent, { kind: 'data' }> =>
            event.kind === 'data' && event.connId === 7,
        )
        .map((event) => event.payload),
    );
    expect(dataBeforeFin.toString()).toBe('greetingtail');
    expect(events.slice(finIndex + 1).some((event) => event.kind === 'data' && event.connId === 7)).toBe(
      false,
    );
    await waitFor(() => localSocket?.destroyed === true);
  });

  test('rejects an OPEN destination outside the declared route without dialing it', async () => {
    let acceptedConnections = 0;
    const localPort = await listenLocal(() => {
      acceptedConnections++;
    });
    tunnel = await establish([{ host: '127.0.0.1', port: localPort }]);

    sendControl({
      type: 'open',
      connId: 8,
      routeId: 'route-1',
      host: '127.0.0.2',
      port: localPort,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openFail', 8));

    expect(controlFor('openFail', 8)).toEqual({
      type: 'openFail',
      connId: 8,
      reason: 'route_not_allowed',
    });
    expect(acceptedConnections).toBe(0);
  });

  test('canonicalizes localhost before authorizing and dialing OPEN', async () => {
    const socket = new net.Socket({ allowHalfOpen: true });
    const createConnection = jest.spyOn(net, 'createConnection').mockReturnValue(socket);
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: 'LOCALHOST', port: 3000 }],
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    expect(controlFor('start')).toEqual({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      routes: [{ host: 'localhost', port: 3000 }],
    });
    sendControl({
      type: 'ready',
      version: DESTINATION_TUNNEL_VERSION,
      tunnelId: 'tunnel-localhost',
    });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 81,
      routeId: 'route-1',
      host: 'localhost',
      port: 3000,
      proto: 'tcp',
    });
    await waitFor(() => createConnection.mock.calls.length === 1);
    expect(createConnection).toHaveBeenCalledWith({
      host: 'localhost',
      port: 3000,
      allowHalfOpen: true,
    });

    sendControl({
      type: 'open',
      connId: 82,
      routeId: 'route-1',
      host: 'LOCALHOST',
      port: 3000,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openFail', 82));
    expect(controlFor('openFail', 82)).toEqual({
      type: 'openFail',
      connId: 82,
      reason: 'route_not_allowed',
    });
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  test('reports a refused local dial with its stable reason and OS code', async () => {
    const unavailablePort = await reserveThenReleasePort();
    const route = { host: '127.0.0.1', port: unavailablePort };
    tunnel = await establish([route]);

    sendControl({
      type: 'open',
      connId: 9,
      routeId: 'route-1',
      host: route.host,
      port: route.port,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openFail', 9));

    expect(controlFor('openFail', 9)).toEqual({
      type: 'openFail',
      connId: 9,
      reason: 'connection_refused',
      osCode: 'ECONNREFUSED',
    });
  });

  test('bounds data queued toward a stalled local connection', async () => {
    const firstSocket = new net.Socket({ allowHalfOpen: true });
    const secondSocket = new net.Socket({ allowHalfOpen: true });
    const firstWriteCallbacks: Array<(error?: Error | null) => void> = [];
    const secondWriteCallbacks: Array<(error?: Error | null) => void> = [];
    stubWrites(firstSocket, firstWriteCallbacks);
    stubWrites(secondSocket, secondWriteCallbacks);
    const createConnection = jest
      .spyOn(net, 'createConnection')
      .mockReturnValueOnce(firstSocket)
      .mockReturnValueOnce(secondSocket);

    const route = { host: '127.0.0.1', port: 8000 };
    tunnel = await establish([route], {
      maxPendingBytesPerConnection: 5,
      maxTotalPendingBytes: 5,
    });
    sendControl({
      type: 'open',
      connId: 10,
      routeId: 'route-1',
      host: route.host,
      port: route.port,
      proto: 'tcp',
    });
    await waitFor(() => createConnection.mock.calls.length === 1);
    firstSocket.emit('connect');
    await waitFor(() => hasControl('openOk', 10));

    sendData(10, Buffer.from('four'));
    await waitFor(() => firstWriteCallbacks.length === 1);
    sendData(10, Buffer.from('xx'));
    await waitFor(() => hasControl('reset', 10));
    expect(controlFor('reset', 10)).toEqual({
      type: 'reset',
      connId: 10,
      reason: 'resource_exhausted',
    });

    firstWriteCallbacks[0]!();
    sendControl({
      type: 'open',
      connId: 11,
      routeId: 'route-1',
      host: route.host,
      port: route.port,
      proto: 'tcp',
    });
    await waitFor(() => createConnection.mock.calls.length === 2);
    secondSocket.emit('connect');
    await waitFor(() => hasControl('openOk', 11));
    sendData(11, Buffer.from('four'));
    await waitFor(() => secondWriteCallbacks.length === 1);
    expect(controlFor('reset', 11)).toBeUndefined();
    secondWriteCallbacks[0]!();
    sendData(11, Buffer.from('four'));
    await waitFor(() => secondWriteCallbacks.length === 2);
    expect(controlFor('reset', 11)).toBeUndefined();
    secondWriteCallbacks[1]!();
  });

  test('rejects binary data before READY', async () => {
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: 8000 }],
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));

    remoteSocket!.send(frame(1, Buffer.from('early')));
    await expect(startup).rejects.toThrow('received tunnel data before READY');
  });

  test('fails startup when READY never arrives', async () => {
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: 8000 }],
      logLevel: 'none',
      handshakeTimeoutMs: 100,
    });
    await expect(startup).rejects.toThrow('destination tunnel was not ready within 100ms');
  });

  test('times out a TCP peer that never completes the WebSocket handshake', async () => {
    const rawServer = net.createServer((socket) => {
      localSockets.add(socket);
      socket.once('close', () => localSockets.delete(socket));
    });
    localServers.push(rawServer);
    await new Promise<void>((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    const port = (rawServer.address() as net.AddressInfo).port;

    const startup = startDestinationTcpTunnel(`ws://127.0.0.1:${port}/stalled`, 'test-token', {
      routes: [{ host: '127.0.0.1', port: 8000 }],
      logLevel: 'none',
      handshakeTimeoutMs: 100,
    });
    await expect(startup).rejects.toThrow('destination tunnel was not ready within 100ms');
  });

  test('keeps a healthy idle tunnel alive with pong frames', async () => {
    tunnel = await establish([{ host: '127.0.0.1', port: 8000 }], {
      livenessTimeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(tunnel.getConnectionState()).toBe('connected');
  });

  test('disconnects a peer that stops sending all frames', async () => {
    await closeRemoteServer();
    await startRemoteServer(false);
    tunnel = await establish([{ host: '127.0.0.1', port: 8000 }], {
      livenessTimeoutMs: 100,
    });
    await waitFor(() => tunnel?.getConnectionState() === 'disconnected');
  });

  test.each([
    ['ENOTFOUND', 'dns_not_found'],
    ['EAI_AGAIN', 'dns_temporary_failure'],
    ['ECONNRESET', 'connection_reset'],
    ['ETIMEDOUT', 'connection_timed_out'],
    ['ENETUNREACH', 'unreachable'],
    ['EACCES', 'permission_denied'],
    ['EMFILE', 'resource_exhausted'],
    ['ECANCELED', 'cancelled'],
    ['EUNKNOWN', 'internal'],
  ])('classifies %s as %s', (code, reason) => {
    expect(classifyOpenFailure(Object.assign(new Error(code), { code }))).toBe(reason);
  });

  async function establish(
    routes: DestinationTunnelRoute[],
    options: {
      maxPendingBytesPerConnection?: number;
      maxTotalPendingBytes?: number;
      livenessTimeoutMs?: number;
    } = {},
  ): Promise<DestinationTcpTunnel> {
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes,
      logLevel: 'none',
      ...options,
    });
    await waitFor(() => hasControl('start'));
    expect(controlFor('start')).toEqual({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      routes,
    });
    sendControl({
      type: 'ready',
      version: DESTINATION_TUNNEL_VERSION,
      tunnelId: 'tunnel-1',
    });
    return startup;
  }

  async function listenLocal(onConnection: (socket: net.Socket) => void): Promise<number> {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      localSockets.add(socket);
      socket.once('close', () => localSockets.delete(socket));
      onConnection(socket);
    });
    localServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  async function reserveThenReleasePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  async function startRemoteServer(autoPong: boolean): Promise<void> {
    remoteServer = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      autoPong,
    });
    remoteServer.on('connection', (socket) => {
      remoteSocket = socket;
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          events.push({
            kind: 'data',
            connId: data.readUInt32BE(0),
            payload: data.subarray(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES),
          });
        } else {
          events.push({
            kind: 'control',
            message: JSON.parse(data.toString('utf8')) as DestinationTunnelClientMessage,
          });
        }
      });
    });
    await new Promise<void>((resolve) => remoteServer.once('listening', resolve));
  }

  async function closeRemoteServer(): Promise<void> {
    remoteSocket?.terminate();
    remoteSocket = undefined;
    await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  }

  function stubWrites(socket: net.Socket, callbacks: Array<(error?: Error | null) => void>): void {
    jest.spyOn(socket, 'write').mockImplementation(((
      _: Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      if (callback) callbacks.push(callback);
      return false;
    }) as typeof socket.write);
  }

  function remoteURL(): string {
    const address = remoteServer.address() as net.AddressInfo;
    return `ws://127.0.0.1:${address.port}/tunnel`;
  }

  function sendControl(message: DestinationTunnelServerMessage): void {
    remoteSocket!.send(JSON.stringify(message));
  }

  function sendData(connId: number, payload: Buffer): void {
    remoteSocket!.send(frame(connId, payload));
  }

  function frame(connId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES);
    header.writeUInt32BE(connId, 0);
    return Buffer.concat([header, payload]);
  }

  function hasControl(type: DestinationTunnelClientMessage['type'], connId?: number): boolean {
    return controlFor(type, connId) !== undefined;
  }

  function controlFor(
    type: DestinationTunnelClientMessage['type'],
    connId?: number,
  ): DestinationTunnelClientMessage | undefined {
    for (const event of events) {
      if (event.kind !== 'control') continue;
      const message = event.message;
      if (
        message.type === type &&
        (connId === undefined || ('connId' in message && message.connId === connId))
      ) {
        return message;
      }
    }
    return undefined;
  }

  function dataFor(connId: number): Buffer {
    return Buffer.concat(
      events
        .filter(
          (event): event is Extract<ClientEvent, { kind: 'data' }> =>
            event.kind === 'data' && event.connId === connId,
        )
        .map((event) => event.payload),
    );
  }
});
