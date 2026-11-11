import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';
import type { PerformanceSample } from '../src';

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
      process.nextTick(() =>
        this['emit'](
          'message',
          Buffer.from(JSON.stringify({ type: `${message.type}Result`, id: message.id })),
        ),
      );
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

const originalFetch = nodeProxyTransport.fetch;

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  sentMessages.length = 0;
});

const connect = async () => {
  const { createInstanceClient } = await import('../src/ios-client');
  return createInstanceClient({ apiUrl: 'https://ios.example.test', token: 'test-token', logLevel: 'none' });
};

// A performance capture always persists, so its start carries a TTL at most and never a persist flag.
test('performance capture messages carry only the optional TTL', async () => {
  const client = await connect();
  try {
    await client.startPerformanceCapture({ ttlSeconds: 3600 });
    await client.stopPerformanceCapture();
    await client.startPerformanceCapture();
    await expect(client.startPerformanceCapture({ ttlSeconds: 0 })).rejects.toThrow(
      'ttlSeconds must be a positive integer',
    );

    const captureMessages = sentMessages.filter((message) =>
      String(message['type']).endsWith('PerformanceCapture'),
    );
    expect(captureMessages.map(({ id, ...message }) => message)).toEqual([
      { type: 'startPerformanceCapture', ttlSeconds: 3600 },
      { type: 'stopPerformanceCapture' },
      { type: 'startPerformanceCapture' },
    ]);
  } finally {
    client.disconnect();
  }
});

test('streamPerformance tails the performance endpoint with the instance token', async () => {
  let requested: string | undefined;
  let authorization: string | null = null;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    requested = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    const sample = {
      ts: 5,
      bundleId: 'com.example.app',
      pid: 7,
      startedAt: 1,
      footprintBytes: 10,
      peakFootprintBytes: 12,
      threadCount: 3,
    };
    return new Response(`retry: 1\n\nid: 1\ndata: ${JSON.stringify(sample)}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const client = await connect();
  try {
    const sample = await new Promise<PerformanceSample>((resolve) => {
      const stop = client.streamPerformance({
        onSample: (received) => {
          stop();
          resolve(received);
        },
      });
    });

    expect(requested).toBe('https://ios.example.test/session/performance/events');
    expect(authorization).toBe('Bearer test-token');
    expect(sample).toMatchObject({ bundleId: 'com.example.app', pid: 7, footprintBytes: 10 });
  } finally {
    client.disconnect();
  }
});

// Ios.streamPerformance needs no WebSocket, so callers that only read samples skip its handshake.
test('Ios.streamPerformance tails the endpoint with only the apiUrl and token', async () => {
  let requested: string | undefined;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
    requested = String(input);
    const sample = {
      ts: 5,
      bundleId: 'com.example.app',
      pid: 7,
      startedAt: 1,
      footprintBytes: 10,
      peakFootprintBytes: 12,
      threadCount: 3,
    };
    return new Response(
      `retry: 1\n\nid: 1\ndata: ${JSON.stringify(sample)}\n\nevent: replayed\ndata: {}\n\n`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  });
  const { streamPerformance } = await import('../src/ios-client');

  const events: string[] = [];
  await new Promise<void>((resolve) => {
    const stop = streamPerformance({
      apiUrl: 'https://ios.example.test',
      token: 'test-token',
      onSample: (sample) => events.push(sample.bundleId),
      onReplayed: () => {
        events.push('replayed');
        stop();
        resolve();
      },
    });
  });

  expect(requested).toBe('https://ios.example.test/session/performance/events');
  expect(events).toEqual(['com.example.app', 'replayed']);
});
