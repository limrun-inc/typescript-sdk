export {};

const sentMessages: Record<string, unknown>[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data) as Record<string, unknown>;
      sentMessages.push(message);
      if (message['type'] === 'getElementTree') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'getElementTreeResult',
                id: message['id'],
                payload: { xml: '<hierarchy />', nodes: [] },
              }),
            ),
          );
        });
      }
      callback?.();
    }

    ping(): void {}

    close(): void {
      this.readyState = 3;
      this['emit']('close');
    }
  }

  return { WebSocket: MockWebSocket };
});

describe('Android getElementTree options', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  async function createClient() {
    const { createInstanceClient } = await import('../src/instance-client');
    return createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      token: 'token',
      logLevel: 'none',
    });
  }

  it('preserves the no-argument request and default timeout', async () => {
    const client = await createClient();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    await expect(client.getElementTree()).resolves.toEqual({ xml: '<hierarchy />', nodes: [] });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ type: 'getElementTree' });
    expect(sentMessages[0]).not.toHaveProperty('waitForIdleTimeoutMs');
    expect(sentMessages[0]).not.toHaveProperty('payload');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    timeoutSpy.mockRestore();
    client.disconnect();
  });

  it('writes the option at the top level and in payload with an extended timeout', async () => {
    const client = await createClient();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    await client.getElementTree({ waitForIdleTimeoutMs: 120_000 });

    expect(sentMessages[0]).toMatchObject({
      type: 'getElementTree',
      waitForIdleTimeoutMs: 120_000,
      payload: { waitForIdleTimeoutMs: 120_000 },
    });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 130_000);
    timeoutSpy.mockRestore();
    client.disconnect();
  });

  it('sends an explicit zero while retaining the default request timeout', async () => {
    const client = await createClient();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    await client.getElementTree({ waitForIdleTimeoutMs: 0 });

    expect(sentMessages[0]).toMatchObject({
      waitForIdleTimeoutMs: 0,
      payload: { waitForIdleTimeoutMs: 0 },
    });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    timeoutSpy.mockRestore();
    client.disconnect();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001])(
    'rejects invalid waitForIdleTimeoutMs %s before sending',
    async (waitForIdleTimeoutMs) => {
      const client = await createClient();

      await expect(client.getElementTree({ waitForIdleTimeoutMs })).rejects.toThrow(
        'waitForIdleTimeoutMs must be a finite non-negative integer no greater than 120000',
      );
      expect(sentMessages).toHaveLength(0);
      client.disconnect();
    },
  );
});
