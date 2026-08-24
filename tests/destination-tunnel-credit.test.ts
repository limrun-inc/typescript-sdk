import net from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  isDialableResolvedAddress,
  startDestinationTcpTunnel,
  type DestinationTcpTunnel,
} from '../src/destination-tunnel-dialer';
import {
  DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES,
  DESTINATION_TUNNEL_VERSION,
  type DestinationTunnelClientMessage,
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

describe('destination tunnel credit and selector dialing', () => {
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
    remoteServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
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
    remoteSocket?.terminate();
    remoteSocket = undefined;
    await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  });

  test('advertises selectors and window in START and window in OPEN-OK', async () => {
    const localPort = await listenLocal(() => {});
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: localPort }],
      domains: ['*.corp.example'],
      window: 4096,
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    expect(controlFor('start')).toEqual({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      routes: [{ host: '127.0.0.1', port: localPort }],
      domains: ['*.corp.example'],
      window: 4096,
    });
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 1,
      routeId: 'route-1',
      host: '127.0.0.1',
      port: localPort,
      proto: 'tcp',
      window: 8,
    });
    await waitFor(() => hasControl('openOk', 1));
    expect(controlFor('openOk', 1)).toEqual({ type: 'openOk', connId: 1, window: 4096 });
  });

  test('sends at most the granted window until windowUpdate arrives', async () => {
    let localSocket: net.Socket | undefined;
    const localPort = await listenLocal((socket) => {
      localSocket = socket;
    });
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: localPort }],
      window: 4096,
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 5,
      routeId: 'route-1',
      host: '127.0.0.1',
      port: localPort,
      proto: 'tcp',
      window: 4,
    });
    await waitFor(() => hasControl('openOk', 5));

    localSocket!.write('0123456789');
    await waitFor(() => dataFor(5).length === 4);
    // Only the granted 4 bytes may leave; the rest waits for more credit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dataFor(5).toString()).toBe('0123');

    sendControl({ type: 'windowUpdate', connId: 5, increment: 3 });
    await waitFor(() => dataFor(5).length === 7);
    expect(dataFor(5).toString()).toBe('0123456');

    sendControl({ type: 'windowUpdate', connId: 5, increment: 1000 });
    await waitFor(() => dataFor(5).length === 10);
    expect(dataFor(5).toString()).toBe('0123456789');
  });

  test('fin never overtakes bytes queued behind send credit', async () => {
    let localSocket: net.Socket | undefined;
    const localPort = await listenLocal((socket) => {
      localSocket = socket;
    });
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: localPort }],
      window: 4096,
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 11,
      routeId: 'route-1',
      host: '127.0.0.1',
      port: localPort,
      proto: 'tcp',
      window: 4,
    });
    await waitFor(() => hasControl('openOk', 11));

    // Write and half-close in one go: 6 of the 10 bytes must wait on credit,
    // and fin must not be sent ahead of them.
    localSocket!.end('0123456789');
    await waitFor(() => dataFor(11).length === 4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hasControl('fin', 11)).toBe(false);

    sendControl({ type: 'windowUpdate', connId: 11, increment: 1000 });
    await waitFor(() => hasControl('fin', 11));
    expect(dataFor(11).toString()).toBe('0123456789');
    const finIndex = events.findIndex(
      (event) => event.kind === 'control' && event.message.type === 'fin',
    );
    const lastDataIndex = events.map((event) => event.kind).lastIndexOf('data');
    expect(finIndex).toBeGreaterThan(lastDataIndex);
  });

  test('replenishes the server send window after local delivery', async () => {
    let received = Buffer.alloc(0);
    const localPort = await listenLocal((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
    });
    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      routes: [{ host: '127.0.0.1', port: localPort }],
      window: 8,
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 6,
      routeId: 'route-1',
      host: '127.0.0.1',
      port: localPort,
      proto: 'tcp',
      window: 1024,
    });
    await waitFor(() => hasControl('openOk', 6));

    sendData(6, Buffer.from('abcdef'));
    await waitFor(() => received.toString() === 'abcdef');
    // 6 delivered bytes >= window/2 (4), so an update must be sent.
    await waitFor(() => hasControl('windowUpdate', 6));
    expect(controlFor('windowUpdate', 6)).toEqual({ type: 'windowUpdate', connId: 6, increment: 6 });
  });

  test('rejects a domain OPEN whose host does not match and dials matching ones via the resolver', async () => {
    let accepted = 0;
    const localPort = await listenLocal(() => {
      accepted++;
    });
    const lookup = jest
      .spyOn(require('dns').promises, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      domains: ['*.corp.example'],
      // The exact route grants dialing the loopback address the mocked
      // resolver returns for the matched domain.
      routes: [{ host: '127.0.0.1', port: localPort }],
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 7,
      routeId: 'domain-1',
      host: 'evil.example',
      port: localPort,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openFail', 7));
    expect(controlFor('openFail', 7)).toEqual({
      type: 'openFail',
      connId: 7,
      reason: 'route_not_allowed',
    });
    expect(accepted).toBe(0);

    sendControl({
      type: 'open',
      connId: 8,
      routeId: 'domain-1',
      host: 'api.corp.example',
      port: localPort,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openOk', 8));
    expect(lookup).toHaveBeenCalledWith('api.corp.example', { all: true, verbatim: true });
    expect(accepted).toBe(1);
  });

  test('blocks domain dials that resolve only to special addresses', async () => {
    jest
      .spyOn(require('dns').promises, 'lookup')
      .mockResolvedValue([
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);

    const startup = startDestinationTcpTunnel(remoteURL(), 'test-token', {
      domains: ['api.corp.example'],
      logLevel: 'none',
    });
    await waitFor(() => hasControl('start'));
    sendControl({ type: 'ready', version: DESTINATION_TUNNEL_VERSION, tunnelId: 'tunnel-1' });
    tunnel = await startup;

    sendControl({
      type: 'open',
      connId: 9,
      routeId: 'domain-1',
      host: 'api.corp.example',
      port: 443,
      proto: 'tcp',
    });
    await waitFor(() => hasControl('openFail', 9));
    expect(controlFor('openFail', 9)).toEqual({
      type: 'openFail',
      connId: 9,
      reason: 'route_not_allowed',
    });
  });

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

  function remoteURL(): string {
    const address = remoteServer.address() as net.AddressInfo;
    return `ws://127.0.0.1:${address.port}/tunnel`;
  }

  function sendControl(message: DestinationTunnelServerMessage): void {
    remoteSocket!.send(JSON.stringify(message));
  }

  function sendData(connId: number, payload: Buffer): void {
    const header = Buffer.alloc(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES);
    header.writeUInt32BE(connId, 0);
    remoteSocket!.send(Buffer.concat([header, payload]));
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

describe('resolved address dial policy', () => {
  test.each([
    ['8.8.8.8', true],
    ['10.1.2.3', true],
    ['192.168.1.5', true],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['169.254.169.254', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['2001:db8::1', true],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['ff02::1', false],
  ])('address %s dialable: %s', (address, dialable) => {
    expect(isDialableResolvedAddress(address, 443, [])).toBe(dialable);
  });

  test('exact routes grant otherwise-blocked targets on the same port only', () => {
    const routes = [{ host: 'localhost', port: 8080 }];
    expect(isDialableResolvedAddress('127.0.0.1', 8080, routes)).toBe(true);
    expect(isDialableResolvedAddress('::1', 8080, routes)).toBe(true);
    expect(isDialableResolvedAddress('127.0.0.1', 9090, routes)).toBe(false);
    expect(isDialableResolvedAddress('169.254.169.254', 8080, routes)).toBe(false);
  });

  test('IPv4-mapped IPv6 addresses follow the IPv4 policy', () => {
    expect(isDialableResolvedAddress('::ffff:127.0.0.1', 443, [])).toBe(false);
    expect(isDialableResolvedAddress('::ffff:8.8.8.8', 443, [])).toBe(true);
  });
});
