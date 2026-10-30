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
              type:
                message.type === 'exportKeychain' ? 'keychainExportResult'
                : message.type === 'importKeychain' ? 'keychainImportResult'
                : `${message.type}Result`,
              id: message.id,
              ...(message.type === 'deviceInfo' ?
                { udid: 'test', screenWidth: 390, screenHeight: 844, model: 'iphone' }
              : {}),
              ...(message.type === 'importKeychain' ? { durationMs: 42 } : {}),
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

describe('iOS keychain transfers', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('saves and restores using only the archive URLs', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/api',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await client.saveKeychain({ url: 'https://assets.example/upload' });
      await expect(client.restoreKeychain({ url: 'https://assets.example/download' })).resolves.toMatchObject(
        { durationMs: 42 },
      );
      expect(sentMessages.filter((message) => message['type'] !== 'deviceInfo')).toEqual([
        { id: expect.any(String), type: 'exportKeychain', url: 'https://assets.example/upload' },
        { id: expect.any(String), type: 'importKeychain', url: 'https://assets.example/download' },
      ]);
    } finally {
      client.disconnect();
    }
  });

  it('rejects legacy encryption options before sending an archive request', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/api',
      token: 'test',
      logLevel: 'none',
    });
    try {
      const legacy = { url: 'https://assets.example/archive', encryptionKey: 'old-key' };
      await expect(client.saveKeychain(legacy)).rejects.toThrow('Keychain encryption is no longer supported');
      await expect(client.restoreKeychain(legacy)).rejects.toThrow(
        'Keychain encryption is no longer supported',
      );
      expect(sentMessages.filter((message) => message['type'] !== 'deviceInfo')).toEqual([]);
    } finally {
      client.disconnect();
    }
  });
});
