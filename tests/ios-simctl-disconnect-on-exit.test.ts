export {};

const sentMessages: Record<string, unknown>[] = [];
const sockets: any[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      sockets.push(this);
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);
      if (message.type === 'deviceInfo') {
        process.nextTick(() =>
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({ type: 'deviceInfoResult', id: message.id, udid: 'u', model: 'iphone' }),
            ),
          ),
        );
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

// Delivers the exit message synchronously, so a throw from the client's message handler
// reaches the test instead of crashing the process.
const finishSimctl = (exitCode: number): void => {
  const request = sentMessages.filter((m) => m['type'] === 'simctl').pop()!;
  sockets[sockets.length - 1].emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'simctlStream', id: request['id'], exitCode })),
  );
};

describe('iOS simctl disconnectOnExit', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    sockets.length = 0;
  });

  const connect = async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    return createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });
  };

  // Appium's boot monitor listens for exit only. The disconnect must not fail the
  // execution that just exited, or its second error event has no listener and throws.
  it('reports the exit without an error event when only exit is observed', async () => {
    const client = await connect();
    const execution = client.simctl(['bootstatus', 'booted'], { disconnectOnExit: true });
    const exits: number[] = [];
    execution.once('exit', (code: number) => exits.push(code));

    expect(() => finishSimctl(0)).not.toThrow();
    expect(exits).toEqual([0]);
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('resolves wait with the exit code', async () => {
    const client = await connect();
    const execution = client.simctl(['bootstatus', 'booted'], { disconnectOnExit: true });
    const result = execution.wait();

    finishSimctl(0);
    await expect(result).resolves.toMatchObject({ code: 0 });
  });
});
