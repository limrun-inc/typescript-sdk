export {};

const mockSockets: string[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor(url: string) {
      super();
      mockSockets.push(url);
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      if (message.type === 'deviceInfo') {
        process.nextTick(() =>
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'deviceInfoResult',
                id: message.id,
                udid: 'test-udid',
                screenWidth: 390,
                screenHeight: 844,
                model: 'iphone',
              }),
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

describe('iOS destination tunnel inspection', () => {
  it('rejects enabled inspection before opening a tunnel', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      const socketsBefore = mockSockets.length;
      await expect(
        client.startTunnel({ selectors: ['api.example.com'], inspection: { enabled: true } } as never),
      ).rejects.toThrow('Tunnel inspection is not available on iOS yet');
      expect(mockSockets.length).toBe(socketsBefore);
    } finally {
      client.disconnect();
    }
  });
});
