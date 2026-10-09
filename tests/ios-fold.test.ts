import type { PerformAction } from '../src/ios-client';

const sentMessages: Record<string, unknown>[] = [];
let mockRecordingSupport = true;
let mockRecordingError: string | undefined;
let mockStopError: string | undefined;
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

      if (message['type'] === 'deviceInfo') {
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
            message['type'] === 'getFoldState' ||
            message['type'] === 'setHingeAngle' ||
            message['type'] === 'setDuoOrientation'
          ) ?
            'foldStateResult'
          : message['type'] === 'screenshotDisplay' ? 'screenshotResult'
          : message['type'] === 'performActions' ? 'performActionsResult'
          : message['type'] === 'scroll' ? 'scrollResult'
          : message['type'] === 'startVideoRecording' ? 'startVideoRecordingResult'
          : message['type'] === 'stopVideoRecording' ? 'stopVideoRecordingResult'
          : 'tapResult';
        process.nextTick(() =>
          this['emit'](
            'message',
            Buffer.from(
              JSON.stringify({
                type,
                id: message.id,
                ...(message.type === 'startVideoRecording' && mockRecordingSupport ?
                  { showTouches: message.showTouches === true }
                : {}),
                error:
                  message.type === 'startVideoRecording' ? mockRecordingError
                  : message.type === 'stopVideoRecording' ? mockStopError
                  : undefined,
                state:
                  message['type'] === 'getFoldState' ?
                    null
                  : {
                      angleDegrees: message.angleDegrees ?? 180,
                      orientation: message.orientation ?? 'portrait',
                      minAngleDegrees: 0,
                      maxAngleDegrees: 180,
                      displays: [],
                    },
                results: message.actions?.map((action: { type: string }) => ({ type: action.type })),
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
    mockRecordingSupport = true;
    mockRecordingError = undefined;
    mockStopError = undefined;
    sentMessages.length = 0;
    mockSockets.length = 0;
  });
  it('routes inner-display gestures and scrolls without changing legacy requests', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      const actions: PerformAction[] = [
        { type: 'touchDown', x: 700, y: 300, x2: 740, y2: 300 },
        { type: 'wait' as const, durationMs: 600 },
        { type: 'touchMove', x: 600, y: 300, x2: 780, y2: 300 },
        { type: 'touchUp', x: 600, y: 300, x2: 780, y2: 300 },
      ];
      await client.performActions(actions, { display: 'inner' });
      await client.scroll('down', 300, { display: 'inner', coordinate: [700, 400], momentum: 0 });
      await client.performActions([{ type: 'tap', x: 20, y: 30 }]);
      const batches = sentMessages.filter((message) => message['type'] === 'performActions');
      expect(batches[0]).toMatchObject({ display: 'inner', actions });
      expect(batches[1]).not.toHaveProperty('display');
      expect(sentMessages.find((message) => message['type'] === 'scroll')).toMatchObject({
        display: 'inner',
        direction: 'down',
        pixels: 300,
        coordinate: [700, 400],
        momentum: 0,
      });
    } finally {
      client.disconnect();
    }
  });

  it('does not rescale native-point taps with cached screen dimensions', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      expect(client.deviceInfo?.screenWidth).toBe(390);
      await client.tap(700, 300);
      await client.tapWithScreenSize(350, 150, 475.5, 334.5);
      const taps = sentMessages.filter((message) => message['type'] === 'tap');
      expect(taps[0]).toEqual({ type: 'tap', id: expect.any(String), x: 700, y: 300 });
      expect(taps[1]).toMatchObject({ x: 350, y: 150, screenWidth: 475.5, screenHeight: 334.5 });
    } finally {
      client.disconnect();
    }
  });

  it('omits the recording target by default and forwards explicit panel overrides', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await client.startRecording();
      await client.startRecording({ display: 'inner' });
      await client.startRecording({ display: 'outer' });
      const recordings = sentMessages.filter((message) => message['type'] === 'startVideoRecording');
      expect(recordings[0]).not.toHaveProperty('display');
      expect(recordings[1]).toMatchObject({ display: 'inner' });
      expect(recordings[2]).toMatchObject({ display: 'outer' });
    } finally {
      client.disconnect();
    }
  });

  it('keeps touch indicators opt-in and forwards them alongside persistence and display options', async () => {
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await client.startRecording();
      await client.startRecording({ showTouches: false });
      await client.startRecording({
        showTouches: true,
        quality: 10,
        persist: { ttlSeconds: 3600 },
        display: 'inner',
      });
      const recordings = sentMessages.filter((message) => message['type'] === 'startVideoRecording');
      expect(recordings[0]).not.toHaveProperty('showTouches');
      expect(recordings[1]).toMatchObject({ showTouches: false });
      expect(recordings[2]).toMatchObject({
        showTouches: true,
        quality: 10,
        persist: true,
        ttlSeconds: 3600,
        display: 'inner',
      });
    } finally {
      client.disconnect();
    }
  });

  it('stops an unmarked recording if an older runtime ignores the opt-in', async () => {
    mockRecordingSupport = false;
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await client.startRecording();
      await expect(client.startRecording({ showTouches: true })).rejects.toThrow(
        'unmarked recording was stopped',
      );
      expect(sentMessages.filter((message) => message['type'] === 'stopVideoRecording')).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

  it("does not stop someone else's recording when start is rejected", async () => {
    mockRecordingError = 'A video recording is already in progress';
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await expect(client.startRecording({ showTouches: true })).rejects.toThrow('already in progress');
      expect(sentMessages.filter((message) => message['type'] === 'stopVideoRecording')).toHaveLength(0);
    } finally {
      client.disconnect();
    }
  });

  it('reports when an unsupported runtime also fails to stop the recording', async () => {
    mockRecordingSupport = false;
    mockStopError = 'connection failed';
    const { createInstanceClient } = await import('../src/ios-client');
    const client = await createInstanceClient({
      apiUrl: 'https://example.test',
      token: 'test',
      logLevel: 'none',
    });
    try {
      await expect(client.startRecording({ showTouches: true })).rejects.toThrow(
        'Could not stop the unmarked recording',
      );
    } finally {
      client.disconnect();
    }
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
