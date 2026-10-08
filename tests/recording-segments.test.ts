import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const messages: Record<string, any>[] = [];
let supportsSegments = true;
const mockFetch = jest.fn();
const segments = [
  { path: 'recording-000000.mp4', width: 360, height: 808, startTimeMs: 0, durationMs: 1000 },
  { path: 'recording-000001.mp4', width: 808, height: 360, startTimeMs: 1000, durationMs: 2000 },
  { path: 'recording-000002.mp4', width: 360, height: 808, startTimeMs: 3000, durationMs: 1000 },
];

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
    readyState = 1;
    constructor() {
      super();
      process.nextTick(() => this['emit']('open'));
    }
    send(data: string, callback?: () => void) {
      const message = JSON.parse(data);
      messages.push(message);
      if (!message.id) return;
      const payload =
        message['type'] === 'deviceInfo' ?
          { udid: 'test', screenWidth: 720, screenHeight: 1616, model: 'iphone' }
        : message['type'].startsWith('start') ?
          supportsSegments ? { segmentOnRotation: !!message.segmentOnRotation }
          : {}
        : { segments };
      process.nextTick(() =>
        this['emit'](
          'message',
          Buffer.from(JSON.stringify({ type: `${message['type']}Result`, id: message.id, ...payload })),
        ),
      );
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

describe.each(['android', 'ios'] as const)('%s segmented recording', (platform) => {
  const connect = async () => {
    const module =
      platform === 'ios' ? await import('../src/ios-client') : await import('../src/instance-client');
    return module.createInstanceClient({
      apiUrl: 'https://instance.test/api',
      token: 'instance-token',
      logLevel: 'none',
    });
  };
  beforeEach(() => {
    messages.length = 0;
    supportsSegments = true;
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => new Response(Buffer.from('mp4 part')));
  });

  it('downloads all parts after reconnecting and writes a portable timeline', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'recording-segments-'));
    const first = await connect();
    await first.startRecording({ segmentOnRotation: true, persist: true });
    first.disconnect();
    const second = await connect();
    try {
      const result = await second.stopRecordingSegments({ localDirectory: directory });
      expect(result).toHaveLength(3);
      expect(result.map((part) => [part.width, part.height])).toEqual([
        [360, 808],
        [808, 360],
        [360, 808],
      ]);
      for (const [index, part] of result.entries()) {
        expect(await readFile(part.localPath!, 'utf8')).toBe('mp4 part');
        const url = new URL(part.downloadUrl);
        expect(url.origin).toBe('https://instance.test');
        expect(url.searchParams.get(platform === 'ios' ? 'name' : 'path')).toBe(segments[index]!.path);
      }
      expect(mockFetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer instance-token');
      const manifest = JSON.parse(await readFile(path.join(directory, 'recording.json'), 'utf8'));
      expect(manifest.segments[1]).toEqual({
        width: 808,
        height: 360,
        startTimeMs: 1000,
        durationMs: 2000,
        path: 'segment-000001.mp4',
      });
      expect(messages.find((message) => message['type'].startsWith('start'))).toMatchObject({
        segmentOnRotation: true,
        persist: true,
      });
      expect(messages.find((message) => message['type'].startsWith('stop'))).toMatchObject({
        segments: true,
      });
    } finally {
      second.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cleans up an older server that silently ignores the requested mode', async () => {
    supportsSegments = false;
    const client = await connect();
    try {
      await expect(client.startRecording({ segmentOnRotation: true })).rejects.toThrow(
        'does not support segmented recording',
      );
      expect(messages.filter((message) => message['type'].startsWith('stop'))).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

  it('keeps default starts and the single-URL stop compatible with old servers', async () => {
    supportsSegments = false;
    const client = await connect();
    try {
      await client.startRecording();
      expect(messages.find((message) => message['type'].startsWith('start'))).not.toHaveProperty(
        'segmentOnRotation',
      );
      expect(await client.stopRecording({})).toContain('/files?');
      expect(messages.find((message) => message['type'].startsWith('stop'))).not.toHaveProperty('segments');
    } finally {
      client.disconnect();
    }
  });
});
