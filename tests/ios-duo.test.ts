import type { DuoViewport } from '../src/ios-client';

const sent: Record<string, unknown>[] = [];
let viewport: DuoViewport | undefined;
let failure: string | undefined;
let emit: (message: unknown) => void;
jest.mock('ws', () => {
  const { EventEmitter } = require('events');
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      emit = (message) => this['emit']('message', Buffer.from(JSON.stringify(message)));
      process.nextTick(() => this['emit']('open'));
    }
    send(raw: string, callback?: () => void) {
      const message = JSON.parse(raw);
      sent.push(message);
      process.nextTick(() => {
        if (message.type === 'deviceInfo')
          emit({
            type: 'deviceInfoResult',
            id: message.id,
            udid: 'test',
            model: viewport ? 'iPhone Duo Preview v1' : 'iPhone 16',
            screenWidth: viewport?.width ?? 390,
            screenHeight: viewport?.height ?? 844,
            duo: viewport,
          });
        if (message.type === 'setDuoPose') {
          if (!failure)
            viewport = {
              ...viewport!,
              pose: message.pose,
              revision: viewport!.revision + 1,
              width: message.pose === 'closed' ? 466 : 890,
              height: message.pose === 'closed' ? 678 : 626,
            };
          emit({ type: 'setDuoPoseResult', id: message.id, viewport, error: failure });
        }
      });
      callback?.();
    }
    ping() {}
    close() {
      this.readyState = 3;
      this['emit']('close');
    }
  }
  return { WebSocket: MockWebSocket };
});

beforeEach(() => {
  sent.length = 0;
  failure = undefined;
  viewport = {
    profile: 'duo-preview-v1',
    pose: 'open',
    revision: 1,
    width: 890,
    height: 626,
    scale: 3,
    runtimeBuild: '24A434',
  };
});
async function connect() {
  const { createInstanceClient } = await import('../src/ios-client');
  return createInstanceClient({
    apiUrl: 'https://example.test/v1/ios_123/api',
    token: 'test',
    logLevel: 'none',
  });
}
test('fold refreshes stale metadata and keeps the public deviceInfo object current', async () => {
  const client = await connect();
  try {
    const info = client.deviceInfo;
    viewport = { ...viewport!, revision: 7 };
    expect(await client.setDuoPose('closed')).toMatchObject({ revision: 8, width: 466, height: 678 });
    expect(sent.find((m) => m['type'] === 'setDuoPose')).toMatchObject({ pose: 'closed', revision: 7 });
    expect(info.screenWidth).toBe(466);
    emit({
      type: 'setDuoPoseResult',
      id: 'duo-viewport-changed',
      viewport: { ...viewport!, pose: 'open', width: 890, height: 626, revision: 9 },
    });
    expect(info.duo?.revision).toBe(9);
    expect(info.screenWidth).toBe(890);
  } finally {
    client.disconnect();
  }
});
test('ordinary simulators reject folding without sending a fold request', async () => {
  viewport = undefined;
  const client = await connect();
  try {
    await expect(client.setDuoPose('closed')).rejects.toThrow('does not support folding');
    expect(sent.some((m) => m['type'] === 'setDuoPose')).toBe(false);
    expect(client.deviceInfo).not.toHaveProperty('duo');
  } finally {
    client.disconnect();
  }
});
test('native errors reach the caller without advancing the cached pose', async () => {
  const client = await connect();
  failure = 'Stop recording before folding';
  try {
    await expect(client.setDuoPose('closed')).rejects.toThrow(failure);
    expect(client.deviceInfo.duo?.pose).toBe('open');
  } finally {
    client.disconnect();
  }
});
