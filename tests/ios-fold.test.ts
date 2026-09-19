export {};

const sentMessages: Record<string, unknown>[] = [];
const mockSockets: Array<{ emit: (event: string, ...args: unknown[]) => boolean }> = [];

jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  type EmittingSocket = { emit: (event: string, ...args: unknown[]) => boolean };

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;

    readyState = MockWebSocket.OPEN;

    constructor() {
      super();
      mockSockets.push(this as unknown as EmittingSocket);
      process.nextTick(() => this['emit']('open'));
    }

    send(data: string, callback?: (err?: Error) => void): void {
      const message = JSON.parse(data);
      sentMessages.push(message);

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
      } else {
        const type =
          (
            message.type === 'getFoldState' ||
            message.type === 'setHingeAngle' ||
            message.type === 'setDuoOrientation'
          ) ?
            'foldStateResult'
          : message.type === 'screenshotDisplay' ? 'screenshotResult'
          : 'tapResult';
        process.nextTick(() =>
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type,
                id: message.id,
                state:
                  message.type === 'getFoldState' ?
                    null
                  : {
                      angleDegrees: message.angleDegrees ?? 180,
                      orientation: message.orientation ?? 'portrait',
                      minAngleDegrees: 0,
                      maxAngleDegrees: 180,
                      displays: [],
                    },
                base64: 'aW1hZ2U=',
                width: 951,
                height: 669,
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

describe('native iPhone Duo controls', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    mockSockets.length = 0;
  });
  it('supports capability absence and routes explicit displays and hinge controls', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      expect(await client.getFoldState()).toBeNull();
      expect((await client.setHingeAngle(45.5)).angleDegrees).toBe(45.5);
      expect((await client.setDuoOrientation('landscape-left')).orientation).toBe('landscape-left');
      expect(await client.screenshotDisplay('inner')).toEqual({
        base64: 'aW1hZ2U=',
        width: 951,
        height: 669,
      });
      await client.tapDisplay('inner', 130, 250);
      expect(sentMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tapDisplay', display: 'inner', x: 130, y: 250 }),
        ]),
      );
      const before = sentMessages.length;
      for (const angle of [NaN, Infinity, -1, 181])
        await expect(client.setHingeAngle(angle)).rejects.toThrow();
      expect(sentMessages).toHaveLength(before);
    } finally {
      client.disconnect();
    }
  });
});
