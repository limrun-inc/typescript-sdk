import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DESTINATION_TUNNEL_VERSION,
  destinationTunnelConfigHash,
  type DestinationTunnelClientMessage,
} from '../src/destination-tunnel';
import { connectTunnel, type TunnelConnector, type TunnelConnectorEvent } from '../src/tunnel-connector';

type Message = Record<string, unknown> & { type: string };

/** Fake backend: the control WebSocket of one tunnel name. */
class FakeBackend {
  readonly messages: Message[] = [];
  readonly upgrades: Array<{ url: string; authorization: string | undefined }> = [];
  readonly closeCodes: number[] = [];
  rejectStatus: number | undefined;
  socket: WebSocket | undefined;
  private readonly server = http.createServer();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.server.on('upgrade', (request, socket: Socket, head) => {
      this.upgrades.push({ url: request.url ?? '', authorization: request.headers.authorization });
      if (this.rejectStatus !== undefined) {
        socket.end(`HTTP/1.1 ${this.rejectStatus} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        this.socket = webSocket;
        webSocket.on('message', (raw) => this.messages.push(JSON.parse(raw.toString()) as Message));
        webSocket.on('close', (code) => this.closeCodes.push(code));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  send(message: Message): void {
    this.socket!.send(JSON.stringify(message));
  }

  of(type: string): Message[] {
    return this.messages.filter((message) => message.type === type);
  }

  async close(): Promise<void> {
    for (const socket of this.wss.clients) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface PodInstance {
  upgrades: number;
  starts: DestinationTunnelClientMessage[];
  deletes: string[];
  statusCalls: number;
  live?: { socket: WebSocket; tunnelId: string; name?: string };
  closedTunnels: string[];
  /** Refuse the tunnel upgrade with this HTTP status. */
  upgradeStatus?: number;
  /** Session error code for the nth start (1-based); undefined accepts it. */
  rejectStart?: (attempt: number) => string | undefined;
  /** Overrides the status body derived from the live session. */
  status?: (call: number) => unknown;
}

/** Fake instance pods behind one router: `<base>/<instanceId>/tunnel...`. */
class FakePod {
  readonly instances = new Map<string, PodInstance>();
  private readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private nextTunnel = 0;

  constructor() {
    this.server = http.createServer((request, response) => {
      const [, instanceId, , tunnelId] = (request.url ?? '').split('/');
      const instance = this.instance(instanceId!);
      if (request.method === 'GET') {
        instance.statusCalls++;
        const body =
          instance.status?.(instance.statusCalls) ??
          (instance.live ? { active: activeStatus(instance.live.tunnelId, instance.live.name) } : {});
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        return;
      }
      const stopped = decodeURIComponent(tunnelId!);
      instance.deletes.push(stopped);
      const live = instance.live;
      if (live?.tunnelId === stopped) live.socket.close();
      response.writeHead(204).end();
    });
    this.server.on('upgrade', (request, socket: Socket, head) => {
      const instance = this.instance((request.url ?? '').split('/')[1]!);
      instance.upgrades++;
      if (instance.upgradeStatus !== undefined) {
        socket.end(
          `HTTP/1.1 ${instance.upgradeStatus} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.once('message', (raw) => {
          const start = JSON.parse(raw.toString()) as DestinationTunnelClientMessage;
          if (start.type !== 'start') throw new Error('expected START');
          instance.starts.push(start);
          const code = instance.rejectStart?.(instance.starts.length);
          if (code) {
            webSocket.send(JSON.stringify({ type: 'error', code }));
            webSocket.close();
            return;
          }
          const tunnelId = `tun-${++this.nextTunnel}`;
          instance.live = { socket: webSocket, tunnelId, ...(start.name ? { name: start.name } : {}) };
          webSocket.on('close', () => {
            instance.closedTunnels.push(tunnelId);
            if (instance.live?.tunnelId === tunnelId) delete instance.live;
          });
          webSocket.send(
            JSON.stringify({
              type: 'ready',
              version: DESTINATION_TUNNEL_VERSION,
              tunnelId,
              selectors: [],
              configHash: destinationTunnelConfigHash(start.selectors, start.inspection),
            }),
          );
        });
      });
    });
  }

  instance(instanceId: string): PodInstance {
    let instance = this.instances.get(instanceId);
    if (!instance) {
      instance = { upgrades: 0, starts: [], deletes: [], statusCalls: 0, closedTunnels: [] };
      this.instances.set(instanceId, instance);
    }
    return instance;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  url(instanceId: string): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/${instanceId}`;
  }

  async close(): Promise<void> {
    for (const socket of this.wss.clients) socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function activeStatus(tunnelId: string, name?: string, state = 'ready'): unknown {
  return {
    tunnelId,
    ...(name ? { name } : {}),
    state,
    selectors: [],
    inspection: {
      enabled: true,
      captureBodies: false,
      maxBodyBytes: 10 * 1024 * 1024,
      persist: false,
      ttlSeconds: 259200,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('tunnel connector', () => {
  let backend: FakeBackend;
  let pod: FakePod;
  let baseURL: string;
  let connector: TunnelConnector | undefined;
  let events: TunnelConnectorEvent[];

  beforeEach(async () => {
    backend = new FakeBackend();
    pod = new FakePod();
    baseURL = await backend.listen();
    await pod.listen();
    events = [];
  });

  afterEach(async () => {
    jest.useRealTimers();
    await connector?.close();
    connector = undefined;
    await Promise.all([backend.close(), pod.close()]);
  });

  function connect(options: { replace?: boolean } = {}): TunnelConnector {
    connector = connectTunnel({
      apiKey: 'lim_key',
      baseURL,
      organizationId: 'org_1',
      name: 'staging',
      selectors: ['localhost:3000'],
      hostname: 'test-host',
      clientVersion: '9.9.9',
      logLevel: 'none',
      onEvent: (event) => events.push(event),
      ...options,
    });
    return connector;
  }

  async function activate(): Promise<void> {
    await waitFor(() => backend.of('hello').length === 1);
    backend.send({ type: 'active', sessionId: 'session-1', leaseSeconds: 30 });
  }

  function attach(instanceId: string): void {
    backend.send({ type: 'attach', instanceId, platform: 'ios', url: pod.url(instanceId), token: 'tok' });
  }

  function attachFailed(instanceId: string): Message | undefined {
    return backend
      .of('attachFailed')
      .find((message) => message['instanceId'] === instanceId && message['terminal']);
  }

  test('says hello, attaches with the tunnel name, and confirms the tunnel ID', async () => {
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    expect(backend.upgrades).toEqual([
      { url: '/v1/organizations/org_1/tunnels/staging/connect', authorization: 'Bearer lim_key' },
    ]);
    expect(backend.of('hello')).toEqual([
      {
        type: 'hello',
        version: 1,
        selectors: ['localhost:3000'],
        replace: false,
        attached: [],
        client: { hostname: 'test-host', cliVersion: '9.9.9' },
      },
    ]);
    expect(pod.instance('ios_1').starts).toEqual([
      expect.objectContaining({ type: 'start', selectors: ['localhost:3000'], name: 'staging' }),
    ]);
    expect(backend.of('attached')).toEqual([{ type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-1' }]);
    expect(events).toEqual([
      { type: 'active', sessionId: 'session-1' },
      { type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-1' },
    ]);
  });

  test('resumes after a server restart with its session, keeping instance tunnels', async () => {
    connect({ replace: true });
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    backend.socket!.close(1012);
    await waitFor(() => backend.of('hello').length === 2);

    expect(backend.of('hello')[0]).toMatchObject({ replace: true, attached: [] });
    expect(backend.of('hello')[1]).toEqual({
      type: 'hello',
      version: 1,
      selectors: ['localhost:3000'],
      replace: false,
      sessionId: 'session-1',
      attached: ['ios_1'],
      client: { hostname: 'test-host', cliVersion: '9.9.9' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'reconnecting', reason: expect.any(String) }),
    );
    const instance = pod.instance('ios_1');
    expect(instance.upgrades).toBe(1);
    expect(instance.closedTunnels).toEqual([]);
  });

  test('confirms a replayed attach without opening another tunnel', async () => {
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 2);

    expect(backend.of('attached')).toEqual([
      { type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-1' },
      { type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-1' },
    ]);
    expect(pod.instance('ios_1').upgrades).toBe(1);
  });

  test('closes the instance tunnel on detach and forgets the instance', async () => {
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    backend.send({ type: 'detach', instanceId: 'ios_1', reason: 'terminated' });
    await waitFor(() => pod.instance('ios_1').closedTunnels.length === 1);
    expect(events).toContainEqual({ type: 'detached', instanceId: 'ios_1', reason: 'terminated' });

    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 2);
    expect(backend.of('attached')[1]).toEqual({ type: 'attached', instanceId: 'ios_1', tunnelId: 'tun-2' });
  });

  test('ends on revoked and closes every instance tunnel without reconnecting', async () => {
    const { closed } = connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    backend.send({ type: 'revoked', reason: 'replaced' });
    await expect(closed).rejects.toThrow('tunnel staging: another connector replaced this one');
    await waitFor(() => pod.instance('ios_1').closedTunnels.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(backend.upgrades).toHaveLength(1);
  });

  test('waits in standby and reports each holder once', async () => {
    connect();
    await waitFor(() => backend.of('hello').length === 1);
    const holder = { hostname: 'other-host', since: '2026-10-08T10:00:00Z' };
    backend.send({ type: 'standby', holder });
    backend.send({ type: 'standby', holder });
    backend.send({ type: 'standby', holder: { ...holder, since: '2026-10-08T11:00:00Z' } });
    await waitFor(() => events.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toEqual([
      { type: 'standby', holder },
      { type: 'standby', holder: { ...holder, since: '2026-10-08T11:00:00Z' } },
    ]);
    expect(pod.instances.size).toBe(0);
  });

  test('stops a dead predecessor tunnel of the same name as the confirmed holder', async () => {
    const instance = pod.instance('ios_1');
    instance.rejectStart = (attempt) => (attempt === 1 ? 'already_active' : undefined);
    instance.status = (call) => (call === 1 ? { active: activeStatus('tun-old', 'staging') } : undefined);
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    expect(instance.deletes).toEqual(['tun-old']);
    expect(instance.starts).toHaveLength(2);
    expect(backend.of('attachFailed')).toEqual([]);
  });

  test('waits for a reclaimed tunnel that is still stopping', async () => {
    const instance = pod.instance('ios_1');
    instance.rejectStart = (attempt) => (attempt <= 2 ? 'already_active' : undefined);
    instance.status = (call) =>
      call === 1 ? { active: activeStatus('tun-old', 'staging') }
      : call === 2 ? { active: activeStatus('tun-old', 'staging', 'stopping') }
      : undefined;
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    expect(instance.deletes).toEqual(['tun-old']);
    expect(instance.starts).toHaveLength(3);
    expect(backend.of('attachFailed')).toEqual([
      expect.objectContaining({ instanceId: 'ios_1', code: 'already_active', terminal: false }),
    ]);
  });

  test('leaves a same-name tunnel alone without a confirmed lease', async () => {
    const instance = pod.instance('ios_1');
    instance.rejectStart = () => 'already_active';
    instance.status = () => ({ active: activeStatus('tun-old', 'staging') });
    connect();
    await waitFor(() => backend.of('hello').length === 1);
    attach('ios_1');
    await waitFor(() => attachFailed('ios_1') !== undefined);

    expect(attachFailed('ios_1')).toMatchObject({ code: 'taken_over', terminal: true });
    expect(instance.deletes).toEqual([]);
  });

  test('yields when another holder took over its dropped tunnel', async () => {
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);
    const instance = pod.instance('ios_1');
    instance.status = () => ({ active: activeStatus('tun-other', 'staging') });
    instance.live!.socket.close();

    await waitFor(() => attachFailed('ios_1') !== undefined);
    expect(attachFailed('ios_1')).toEqual({
      type: 'attachFailed',
      instanceId: 'ios_1',
      code: 'taken_over',
      message: 'another connector for this tunnel took the instance over',
      terminal: true,
    });
    expect(instance.upgrades).toBe(1);
    expect(instance.deletes).toEqual([]);
  });

  test('yields when a retry after a drop meets another holder', async () => {
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);
    const instance = pod.instance('ios_1');
    instance.rejectStart = (attempt) => (attempt === 2 ? 'already_active' : undefined);
    instance.status = (call) => (call === 1 ? {} : { active: activeStatus('tun-other', 'staging') });
    instance.live!.socket.close();

    await waitFor(() => attachFailed('ios_1') !== undefined);
    expect(attachFailed('ios_1')).toMatchObject({ code: 'taken_over', terminal: true });
    expect(instance.deletes).toEqual([]);
  });

  test('reports instance_busy when the instance has a tunnel of another name', async () => {
    const instance = pod.instance('ios_1');
    instance.rejectStart = () => 'already_active';
    instance.status = () => ({ active: activeStatus('tun-cli') });
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => attachFailed('ios_1') !== undefined);

    expect(attachFailed('ios_1')).toEqual({
      type: 'attachFailed',
      instanceId: 'ios_1',
      code: 'instance_busy',
      message: 'the instance already has another tunnel',
      terminal: true,
    });
    expect(instance.deletes).toEqual([]);
    expect(events).toContainEqual({
      type: 'attachFailed',
      instanceId: 'ios_1',
      code: 'instance_busy',
      message: 'the instance already has another tunnel',
    });
  });

  test('gives up on an instance the router no longer knows', async () => {
    pod.instance('ios_1').upgradeStatus = 404;
    connect();
    await activate();
    attach('ios_1');
    await waitFor(() => attachFailed('ios_1') !== undefined);

    expect(attachFailed('ios_1')).toMatchObject({ code: 'instance_gone', terminal: true });
    expect(pod.instance('ios_1').upgrades).toBe(1);
  });

  test('gives up after five minutes of failed attempts', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const instance = pod.instance('ios_1');
    instance.upgradeStatus = 503;
    const settle = async (predicate: () => boolean): Promise<void> => {
      for (let spin = 0; spin < 10_000 && !predicate(); spin++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!predicate()) throw new Error('settle timed out');
    };
    connect();
    await settle(() => backend.of('hello').length === 1);
    backend.send({ type: 'active', sessionId: 'session-1', leaseSeconds: 30 });
    attach('ios_1');
    const startedAt = Date.now();

    for (let step = 0; step < 200 && !attachFailed('ios_1'); step++) {
      await settle(() => instance.upgrades > 0 && backend.of('attachFailed').length === instance.upgrades);
      await jest.advanceTimersByTimeAsync(5_000);
    }

    expect(attachFailed('ios_1')).toMatchObject({ code: 'attach_timeout', terminal: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5 * 60_000);
    expect(backend.of('attachFailed').filter((message) => !message['terminal']).length).toBeGreaterThan(5);
    await connector!.close();
  });

  test('ends when the API refuses the upgrade with 403', async () => {
    backend.rejectStatus = 403;
    const { closed } = connect();

    await expect(closed).rejects.toThrow(
      'tunnel staging: connecting a tunnel needs an admin API key with tunnel access (HTTP 403)',
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(backend.upgrades).toHaveLength(1);
  });

  test.each([429, 503])('retries when the API answers the upgrade with %d', async (status) => {
    backend.rejectStatus = status;
    connect();
    await waitFor(() => backend.upgrades.length >= 2);
    backend.rejectStatus = undefined;
    await waitFor(() => backend.of('hello').length === 1);
  });

  test('close says bye, closes normally, and closes instance tunnels', async () => {
    const { closed, close } = connect();
    await activate();
    attach('ios_1');
    await waitFor(() => backend.of('attached').length === 1);

    await close();
    await expect(closed).resolves.toBeUndefined();
    expect(backend.of('bye')).toEqual([{ type: 'bye' }]);
    await waitFor(() => backend.closeCodes.length === 1 && pod.instance('ios_1').closedTunnels.length === 1);
    expect(backend.closeCodes).toEqual([1000]);
  });
});
