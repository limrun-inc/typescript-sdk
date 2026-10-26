// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppleRelayError, AppleRelayWebSocketClient } from './relay';

const sessionA = '0123456789abcdef0123456789abcdef';
const sessionB = 'fedcba9876543210fedcba9876543210';

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor() {
    MockWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

async function connect(client = new AppleRelayWebSocketClient('https://registry.example.com')) {
  const connected = client.connect();
  const socket = MockWebSocket.instances.at(-1)!;
  socket.open();
  await connected;
  return { client, socket };
}

describe('relay support references', () => {
  test('retains the announcement and attaches the reference to responses and relay errors', async () => {
    const { client, socket } = await connect();
    socket.message({ type: 'session', id: '', ok: true, relaySessionId: sessionA });
    expect(client.relaySessionId).toBe(sessionA);
    const response = client.request('finalize');
    socket.message({
      id: '1',
      ok: true,
      relaySessionId: sessionA,
      response: { status: 403, rawBody: '{"serviceErrors":[{"code":"-20209"}]}' },
    });
    expect(await response).toMatchObject({
      relaySessionId: sessionA,
      status: 403,
      body: { serviceErrors: [{ code: '-20209' }] },
    });
    const failure = client.request('unknown');
    socket.message({ id: '2', ok: false, relaySessionId: sessionA, error: 'Unsupported request' });
    await expect(failure).rejects.toMatchObject({ name: 'AppleRelayError', relaySessionId: sessionA });
  });

  test.each(['onclose', 'onerror'] as const)('keeps the reference on %s', async (event) => {
    const { client, socket } = await connect();
    socket.message({ type: 'session', ok: true, relaySessionId: sessionA });
    const response = client.request('srpInit');
    socket[event]?.();
    await expect(response).rejects.toMatchObject({ relaySessionId: sessionA });
    expect(client.relaySessionId).toBe(sessionA);
  });

  test('uses response metadata without an announcement and supports older servers without an ID', async () => {
    const { client, socket } = await connect();
    const oldResponse = client.request('finalize');
    socket.message({ id: '1', ok: true, response: { status: 200 } });
    expect((await oldResponse).relaySessionId).toBeUndefined();
    const response = client.request('finalize');
    socket.message({ id: '2', ok: true, relaySessionId: sessionA, response: { status: 200 } });
    expect((await response).relaySessionId).toBe(sessionA);
  });

  test('clears the previous reference on reconnect and ignores late events from the old socket', async () => {
    const { client, socket: oldSocket } = await connect();
    oldSocket.message({ type: 'session', ok: true, relaySessionId: sessionA });
    client.close();
    expect(client.relaySessionId).toBe(sessionA);
    const reconnecting = client.connect();
    expect(client.relaySessionId).toBeUndefined();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await reconnecting;
    socket.message({ type: 'session', ok: true, relaySessionId: sessionB });
    const response = client.request('finalize');
    oldSocket.message({ type: 'session', ok: true, relaySessionId: sessionA });
    oldSocket.onclose?.();
    socket.message({ id: '1', ok: true, relaySessionId: sessionB, response: { status: 200 } });
    expect((await response).relaySessionId).toBe(sessionB);
  });

  test('connection failures before an announcement have no reference', async () => {
    const client = new AppleRelayWebSocketClient('https://registry.example.com');
    const connected = client.connect();
    MockWebSocket.instances[0]!.onerror?.();
    await expect(connected).rejects.toBeInstanceOf(AppleRelayError);
    expect(client.relaySessionId).toBeUndefined();
  });
});
