const mockFetch = jest.fn();

jest.mock('../src/internal/proxy-transport', () => ({
  nodeProxyTransport: {
    fetch: (...args: unknown[]) => mockFetch(...args),
    getWebSocketAgent: () => undefined,
  },
}));

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
        process.nextTick(() => {
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

describe('iOS file listing', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('lists an app data-container directory and returns pull-ready paths', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          {
            name: 'video.mov',
            path: 'Documents/video.mov',
            isDirectory: false,
            size: 1234,
          },
        ],
      }),
    });
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await expect(
      client.listFiles('Documents', {
        bundleId: 'com.example.app',
        containerType: 'data',
      }),
    ).resolves.toEqual([
      {
        name: 'video.mov',
        path: 'Documents/video.mov',
        isDirectory: false,
        size: 1234,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.test/v1/ios_123/api/files/list?path=Documents&bundleId=com.example.app&containerType=data',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      },
    );

    client.disconnect();
  });

  it('lists the staging root without a query string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await expect(client.listFiles()).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith('https://example.test/v1/ios_123/api/files/list', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    client.disconnect();
  });

  it('includes the path and server response when listing fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '{"message":"Directory not found: Documents"}',
    });
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/ios_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await expect(client.listFiles('Documents')).rejects.toThrow(
      `Listing of 'Documents' failed: 404 {"message":"Directory not found: Documents"}`,
    );

    client.disconnect();
  });
});
