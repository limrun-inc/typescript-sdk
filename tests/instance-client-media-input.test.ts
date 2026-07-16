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
      const message = JSON.parse(data);
      sentMessages.push(message);
      if (message.type === 'setMediaInput') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'setMediaInputResult',
                id: message.id,
                payload: {
                  path: message.path,
                  duration: 4_200_000,
                  once: message.once ?? false,
                  generation: 7,
                  width: 1280,
                  height: 720,
                  hasAudio: true,
                },
              }),
            ),
          );
        });
      } else if (message.type === 'clearMediaInput') {
        process.nextTick(() => {
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'clearMediaInputResult',
                id: message.id,
                payload: {},
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

describe('Android combined media input', () => {
  beforeEach(() => {
    sentMessages.length = 0;
  });

  it('serializes setMediaInput and resolves its typed result payload', async () => {
    const { createInstanceClient } = await import('../src/instance-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      token: 'token',
      logLevel: 'none',
    });

    const result = await client.setMediaInput('/data/local/tmp/camera.mp4', { once: true });

    expect(sentMessages.find((message) => message['type'] === 'setMediaInput')).toMatchObject({
      type: 'setMediaInput',
      path: '/data/local/tmp/camera.mp4',
      once: true,
      payload: {
        path: '/data/local/tmp/camera.mp4',
        once: true,
      },
    });
    expect(result).toEqual({
      path: '/data/local/tmp/camera.mp4',
      duration: 4_200_000,
      once: true,
      generation: 7,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    client.disconnect();
  });

  it('serializes clearMediaInput and resolves void', async () => {
    const { createInstanceClient } = await import('../src/instance-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      token: 'token',
      logLevel: 'none',
    });

    await expect(client.clearMediaInput()).resolves.toBeUndefined();
    expect(sentMessages.find((message) => message['type'] === 'clearMediaInput')).toMatchObject({
      type: 'clearMediaInput',
    });
    client.disconnect();
  });

  it('rejects relative media paths before sending', async () => {
    const { createInstanceClient } = await import('../src/instance-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test/v1/android_123/api',
      token: 'token',
      logLevel: 'none',
    });
    sentMessages.length = 0;

    await expect(client.setMediaInput('relative.mp4')).rejects.toThrow(
      'path must be an absolute on-device path',
    );
    expect(sentMessages).toEqual([]);
    client.disconnect();
  });
});
