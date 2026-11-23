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

import Limrun, { GradleSnapshotGoneError, type GradleInstanceSnapshot } from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';

const originalFetch = nodeProxyTransport.fetch;

describe('gradle snapshot follower', () => {
  beforeEach(() => {
    sources.length = 0;
  });

  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('reports every phase change once and resolves on a terminal restore', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const seen: string[] = [];
    const following = client.gradleInstances.followSnapshot('gradle_1', {
      onUpdate: (snapshot) => seen.push(snapshot.restore.phase),
    });
    const source = await nextSource();

    source.emit(snapshotEvent({ restore: 'pending' }));
    source.emit(snapshotEvent({ restore: 'downloading' }));
    // A reconnect replays the current state, which is not a transition.
    source.emit(snapshotEvent({ restore: 'downloading' }));
    // Xcode's stream event is not this one, and is ignored.
    source.emit({ event: 'cache', data: JSON.stringify(state({ restore: 'failed' })) });
    source.emit(snapshotEvent({ restore: 'extracting' }));
    source.emit(snapshotEvent({ restore: 'restored' }));

    const result = await following;
    expect(seen).toEqual(['pending', 'downloading', 'extracting', 'restored']);
    expect(result.gone).toBe(false);
    expect(result.snapshot.restore.phase).toBe('restored');
    expect(source.url).toBe('https://api.example.test/v1/gradle_instances/gradle_1/snapshot');
    expect(source.closed).toBe(true);
  });

  test('waiting on the save side ignores the restore reaching its own terminal phase', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    const following = client.gradleInstances.followSnapshot('gradle_1', { side: 'save' });
    const source = await nextSource();

    source.emit(snapshotEvent({ restore: 'restored', save: 'requested' }));
    source.emit(snapshotEvent({ restore: 'restored', save: 'uploading' }));
    expect(source.closed).toBe(false);

    source.emit(snapshotEvent({ restore: 'restored', save: 'published' }));
    const result = await following;
    expect(result.snapshot.save.phase).toBe('published');
  });

  test('a stream that opens on a collected instance ends, rather than retrying a 404 to the timeout', async () => {
    const client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test' });
    nodeProxyTransport.fetch = jest.fn(async () => new Response('{"message":"not found"}', { status: 404 }));

    const following = client.gradleInstances.followSnapshot('gradle_1', { side: 'save' });
    const source = await nextSource();
    await source.connect();

    await expect(following).rejects.toThrow(GradleSnapshotGoneError);
    expect(source.closed).toBe(true);
  });
});

function state(phases: { restore: string; save?: string }): GradleInstanceSnapshot {
  return {
    restore: { phase: phases.restore as GradleInstanceSnapshot['restore']['phase'] },
    save: { phase: (phases.save ?? 'idle') as GradleInstanceSnapshot['save']['phase'] },
  };
}

function snapshotEvent(phases: { restore: string; save?: string }): SseMessage {
  return { event: 'snapshot', data: JSON.stringify(state(phases)) };
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
