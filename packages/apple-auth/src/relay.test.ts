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
  test('learns the reference from the first response, including an Apple failure', async () => {
    const { client, socket } = await connect();
    expect(client.relaySessionId).toBeUndefined();
    expect(socket.send).not.toHaveBeenCalled();
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
    expect(client.relaySessionId).toBe(sessionA);
  });

  test('learns the reference when the first request fails at the relay', async () => {
    const { client, socket } = await connect();
    const failure = client.request('unknown');
    socket.message({ id: '1', ok: false, relaySessionId: sessionA, error: 'Unsupported request' });
    await expect(failure).rejects.toMatchObject({ name: 'Error', relaySessionId: sessionA });
    expect(client.relaySessionId).toBe(sessionA);
  });

  test.each(['onclose', 'onerror'] as const)('keeps the reference on %s after a response', async (event) => {
    const { client, socket } = await connect();
    const init = client.request('srpInit');
    socket.message({ id: '1', ok: true, relaySessionId: sessionA, response: { status: 200 } });
    await init;
    const response = client.request('srpComplete');
    socket[event]?.();
    await expect(response).rejects.toMatchObject({ relaySessionId: sessionA });
    expect(client.relaySessionId).toBe(sessionA);
  });

  test('supports older servers without an ID', async () => {
    const { client, socket } = await connect();
    const response = client.request('finalize');
    socket.message({ id: '1', ok: true, response: { status: 200 } });
    expect((await response).relaySessionId).toBeUndefined();
    expect(client.relaySessionId).toBeUndefined();
  });

  test('clears the previous reference on reconnect and ignores old socket events', async () => {
    const { client, socket: oldSocket } = await connect();
    const init = client.request('srpInit');
    oldSocket.message({ id: '1', ok: true, relaySessionId: sessionA, response: { status: 200 } });
    await init;
    client.close();
    expect(client.relaySessionId).toBe(sessionA);
    const reconnecting = client.connect();
    expect(client.relaySessionId).toBeUndefined();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await reconnecting;
    const response = client.request('finalize');
    oldSocket.message({ id: '2', ok: false, relaySessionId: sessionA, error: 'Old connection' });
    oldSocket.onclose?.();
    expect(client.relaySessionId).toBeUndefined();
    socket.message({ id: '2', ok: true, relaySessionId: sessionB, response: { status: 200 } });
    expect((await response).relaySessionId).toBe(sessionB);
  });

  test('disconnects before the first response have no reference', async () => {
    const { client, socket } = await connect();
    const response = client.request('srpInit');
    socket.onclose?.();
    await expect(response).rejects.toBeInstanceOf(AppleRelayError);
    await expect(response).rejects.toMatchObject({ name: 'Error', relaySessionId: undefined });
    expect(client.relaySessionId).toBeUndefined();
  });
});
