export {};

const sentMessages: Record<string, unknown>[] = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);
      process.nextTick(() => {
        this['emit'](
          'message',
          Buffer.from(
            JSON.stringify({
              type: `${message.type}Result`,
              id: message.id,
              ...(message.type === 'deviceInfo' ?
                { udid: 'test', screenWidth: 390, screenHeight: 844, model: 'iphone' }
              : {}),
              ...(message.type === 'getPermission' ? { status: 'limited' } : {}),
              ...(message.type === 'setPermission' && message.service === 'location' ?
                { error: "'location' is not a supported privacy service" }
              : {}),
              ...(message.type === 'performActions' ? { results: [] } : {}),
            }),
          ),
        );
      });
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

describe('iOS permissions, services and keychain', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  async function client() {
    const { createInstanceClient } = await import('../src/ios-client');
    return createInstanceClient({ apiUrl: 'https://example.test/api', token: 'test', logLevel: 'none' });
  }

  it('sends each request and returns the permission status', async () => {
    const instance = await client();
    try {
      await instance.setPermission('com.example.app', 'faceid', 'granted');
      await expect(instance.getPermission('com.example.app', 'photos')).resolves.toBe('limited');
      await instance.restartServices(['com.apple.SpringBoard', 'com.apple.tccd']);
      await instance.resetKeychain();
      await instance.setOrientation('PortraitUpsideDown');
      await instance.performActions([
        { type: 'usageDown', usagePage: 0x0c, usage: 0x6f },
        { type: 'usageUp', usagePage: 0x0c, usage: 0x6f },
      ]);
      expect(sentMessages.filter((message) => message['type'] !== 'deviceInfo')).toEqual([
        {
          id: expect.any(String),
          type: 'setPermission',
          bundleId: 'com.example.app',
          service: 'faceid',
          status: 'granted',
        },
        { id: expect.any(String), type: 'getPermission', bundleId: 'com.example.app', service: 'photos' },
        {
          id: expect.any(String),
          type: 'restartServices',
          services: ['com.apple.SpringBoard', 'com.apple.tccd'],
        },
        { id: expect.any(String), type: 'resetKeychain' },
        { id: expect.any(String), type: 'setOrientation', orientation: 'PortraitUpsideDown' },
        expect.objectContaining({
          type: 'performActions',
          actions: [
            { type: 'usageDown', usagePage: 0x0c, usage: 0x6f },
            { type: 'usageUp', usagePage: 0x0c, usage: 0x6f },
          ],
        }),
      ]);
    } finally {
      instance.disconnect();
    }
  });

  it('rejects with the server error', async () => {
    const instance = await client();
    try {
      await expect(instance.setPermission('com.example.app', 'location' as never, 'granted')).rejects.toThrow(
        "'location' is not a supported privacy service",
      );
    } finally {
      instance.disconnect();
    }
  });
});
