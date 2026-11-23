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

const SAMPLE = {
  ts: 5,
  bundleId: 'com.example.app',
  pid: 7,
  startedAt: 1,
  footprintBytes: 10,
  peakFootprintBytes: 12,
  threadCount: 3,
};

test('streamPerformance tails the performance endpoint with the instance token', async () => {
  let requested: string | undefined;
  let authorization: string | null = null;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    requested = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(`retry: 1\n\nid: 1\ndata: ${JSON.stringify(SAMPLE)}\n\n`, {
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
  let authorization: string | null = null;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    requested = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(
      `retry: 1\n\nid: 1\ndata: ${JSON.stringify(SAMPLE)}\n\nevent: replayed\ndata: {}\n\n`,
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
  expect(authorization).toBe('Bearer test-token');
  expect(events).toEqual(['com.example.app', 'replayed']);
});

const postedTo = (fetch: unknown) =>
  (fetch as jest.Mock).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method,
    authorization: new Headers(init?.headers).get('Authorization'),
    body: JSON.parse(String(init?.body)),
  }));

test('sampleStacks and memoryReport post the app to the instance and return its reports', async () => {
  const stacks = { bundleId: 'com.example.app', pid: 7, durationSeconds: 3, report: 'Call graph:\n' };
  const memory = {
    bundleId: 'com.example.app',
    pid: 7,
    footprintBytes: 10,
    peakFootprintBytes: 12,
    leakCount: 2,
    leakedBytes: 1808,
    leaks: 'Process 7: 2 leaks for 1808 total leaked bytes.\n',
    heap: 'COUNT BYTES\n',
    regions: 'Physical footprint: 10\n',
  };
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) =>
    Response.json(String(input).endsWith('/stacks') ? stacks : memory),
  );
  const client = await connect();
  try {
    expect(await client.sampleStacks({ bundleId: 'com.example.app', durationSeconds: 3 })).toEqual(stacks);
    // Without options the instance picks the app launched last.
    expect(await client.memoryReport()).toEqual(memory);
    expect(postedTo(nodeProxyTransport.fetch)).toEqual([
      {
        url: 'https://ios.example.test/performance/stacks',
        method: 'POST',
        authorization: 'Bearer test-token',
        body: { bundleId: 'com.example.app', durationSeconds: 3 },
      },
      {
        url: 'https://ios.example.test/performance/memory',
        method: 'POST',
        authorization: 'Bearer test-token',
        body: {},
      },
    ]);
  } finally {
    client.disconnect();
  }
});

// A runtime from before these operations has no such route, which is the one case a caller can fix
// by creating a new instance.
test('a 404 from the instance says its runtime cannot profile apps', async () => {
  const { AppProfilingUnavailableError } = await import('../src/ios-client');
  nodeProxyTransport.fetch = jest.fn(async () => new Response('Not Found', { status: 404 }));
  const client = await connect();
  try {
    await expect(client.sampleStacks()).rejects.toBeInstanceOf(AppProfilingUnavailableError);
    await expect(client.memoryReport()).rejects.toBeInstanceOf(AppProfilingUnavailableError);
  } finally {
    client.disconnect();
  }
});

test('other refusals carry the instance message and status', async () => {
  nodeProxyTransport.fetch = jest.fn(async () =>
    Response.json({ message: 'com.example.app is not running.' }, { status: 422 }),
  );
  const client = await connect();
  try {
    await expect(client.sampleStacks({ bundleId: 'com.example.app' })).rejects.toMatchObject({
      message: 'com.example.app is not running.',
      status: 422,
    });
  } finally {
    client.disconnect();
  }
});
