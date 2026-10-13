export {};

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
      const message = JSON.parse(data);
      if (message.type === 'deviceInfo') {
        const reply = {
          type: 'deviceInfoResult',
          id: message.id,
          udid: 'test-udid',
          model: 'iPhone 16 Pro',
          osVersion: '27.0',
        };
        process.nextTick(() => this['emit']('message', Buffer.from(JSON.stringify(reply))));
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

describe('iOS device info', () => {
  it('carries the iOS version the simulator runs', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      expect(client.deviceInfo.osVersion).toBe('27.0');
    } finally {
      client.disconnect();
    }
  });
});
