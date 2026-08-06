type SseMessage = { event: string; data: string };
type SseHandle = {
  emit: (message: SseMessage) => void;
  closed: boolean;
  url: string;
  /** Drives the connection the client would make, so its outcome can be chosen per test. */
  connect: () => Promise<Response>;
  announceOpen: () => void;
};

const sources: SseHandle[] = [];

jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn(
    (options: {
      url: string;
      onMessage: (message: SseMessage) => void;
      onConnect?: () => void;
      fetch: (url: string, init?: unknown) => Promise<Response>;
    }): { close: () => void } => {
      const handle: SseHandle = {
        url: options.url,
        closed: false,
        emit: (message) => options.onMessage(message),
        connect: () => options.fetch(options.url),
        announceOpen: () => options.onConnect?.(),
      };
      sources.push(handle);
      return {
        close: () => {
          handle.closed = true;
        },
      };
    },
  ),
}));

import Limrun, { XcodeCacheGoneError } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { XcodeInstanceCache } from '../src/xcode-cache';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode cache follower', () => {
  beforeEach(() => {
    sources.length = 0;
  });

  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('reports every phase change once and resolves on a terminal restore', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const seen: string[] = [];
    const following = client.xcodeInstances.followCache('sandbox_1', {
      onUpdate: (cache) => seen.push(cache.restore.phase),
    });
    const source = await nextSource();

    source.emit(cacheEvent({ restore: 'placing' }));
    source.emit(cacheEvent({ restore: 'downloading' }));
    // A reconnect replays the current state, which is not a transition.
    source.emit(cacheEvent({ restore: 'downloading' }));
    source.emit(cacheEvent({ restore: 'restored' }));

    const result = await following;
    expect(seen).toEqual(['placing', 'downloading', 'restored']);
    expect(result.gone).toBe(false);
    expect(result.cache.restore.phase).toBe('restored');
    expect(source.url).toBe('https://api.example.test/v1/xcode_instances/sandbox_1/cache');
    expect(source.closed).toBe(true);
  });

  test('a cold outcome resolves like any other, since it is not a failure', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const following = client.xcodeInstances.followCache('sandbox_1');
    const source = await nextSource();
    source.emit(cacheEvent({ restore: 'skipped', restoreReason: 'no_match' }));

    const result = await following;
    expect(result.cache.restore.phase).toBe('skipped');
    expect(result.cache.restore.reason).toBe('no_match');
  });

  test('waiting on the save side ignores the restore reaching its own terminal phase', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const following = client.xcodeInstances.followCache('sandbox_1', { side: 'save' });
    const source = await nextSource();

    source.emit(cacheEvent({ restore: 'restored', save: 'idle' }));
    source.emit(cacheEvent({ restore: 'restored', save: 'uploading' }));
    expect(source.closed).toBe(false);

    source.emit(cacheEvent({ restore: 'restored', save: 'published' }));
    const result = await following;
    expect(result.cache.save.phase).toBe('published');
  });

  test('a gone event is confirmed against the instance, since a cut watch also sends it', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    let status = 200;
    nodeProxyTransport.fetch = jest.fn(async () =>
      status === 404 ?
        new Response('{"message":"not found"}', { status: 404 })
      : new Response(JSON.stringify(snapshot({ restore: 'downloading' })), { status: 200 }),
    );

    const following = client.xcodeInstances.followCache('sandbox_1');
    const source = await nextSource();

    source.emit(cacheEvent({ restore: 'downloading' }));
    source.emit({ event: 'gone', data: JSON.stringify(snapshot({ restore: 'downloading' })) });
    await flush();
    expect(source.closed).toBe(false);

    status = 404;
    source.emit({ event: 'gone', data: JSON.stringify(snapshot({ restore: 'downloading' })) });
    const result = await following;
    expect(result.gone).toBe(true);
    expect(result.cache.restore.phase).toBe('downloading');
  });

  test('a stream that opens on a collected instance ends, rather than retrying a 404 to the timeout', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    nodeProxyTransport.fetch = jest.fn(async () => new Response('{"message":"not found"}', { status: 404 }));

    const following = client.xcodeInstances.followCache('sandbox_1', { side: 'save' });
    const source = await nextSource();
    await source.connect();

    await expect(following).rejects.toThrow(XcodeCacheGoneError);
    expect(source.closed).toBe(true);
  });

  test('an instance collected mid-follow resolves with the last phase it reported', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    nodeProxyTransport.fetch = jest.fn(async () => new Response('{"message":"not found"}', { status: 404 }));

    const following = client.xcodeInstances.followCache('sandbox_1', { side: 'save' });
    const source = await nextSource();
    source.emit(cacheEvent({ restore: 'restored', save: 'uploading' }));
    await source.connect();

    const result = await following;
    expect(result.gone).toBe(true);
    expect(result.cache.save.phase).toBe('uploading');
  });

  test('announces the open stream, so a caller can subscribe before causing what it watches', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    let opened = false;
    const following = client.xcodeInstances.followCache('sandbox_1', {
      side: 'save',
      onOpen: () => {
        opened = true;
      },
    });
    const source = await nextSource();
    expect(opened).toBe(false);

    source.announceOpen();
    expect(opened).toBe(true);

    source.emit(cacheEvent({ restore: 'restored', save: 'published' }));
    await following;
  });

  test('times out instead of waiting forever on a restore that never finishes', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const following = client.xcodeInstances.followCache('sandbox_1', { timeoutMs: 5 });
    const source = await nextSource();
    source.emit(cacheEvent({ restore: 'downloading' }));

    await expect(following).rejects.toThrow(/Timed out/);
    expect(source.closed).toBe(true);
  });
});

function snapshot(phases: { restore: string; save?: string; restoreReason?: string }): XcodeInstanceCache {
  return {
    restore: {
      phase: phases.restore as XcodeInstanceCache['restore']['phase'],
      ...(phases.restoreReason ? { reason: phases.restoreReason } : {}),
    },
    save: { phase: (phases.save ?? 'idle') as XcodeInstanceCache['save']['phase'] },
  };
}

function cacheEvent(phases: { restore: string; save?: string; restoreReason?: string }): SseMessage {
  return { event: 'cache', data: JSON.stringify(snapshot(phases)) };
}

async function nextSource(): Promise<SseHandle> {
  await flush();
  const source = sources[sources.length - 1];
  if (!source) throw new Error('no event source was opened');
  return source;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
