import { exec, sseStreamPolicy } from '../src/exec-client';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const API_URL = 'https://xcode.example.test';

const originalFetch = nodeProxyTransport.fetch;
const originalPolicy = { ...sseStreamPolicy };

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  Object.assign(sseStreamPolicy, originalPolicy);
  jest.restoreAllMocks();
});

/**
 * A one-shot SSE response with the given frames, closed immediately. The
 * `retry: 1` prologue drops the client's reconnect delay to 1ms so broken
 * cycles are fast under test.
 */
const sseResponse = (frames: string[]): Response =>
  new Response('retry: 1\n\n' + frames.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

/** An SSE response that delivers its frames, then stays open for holdMs before closing. */
const heldSseResponse = (frames: string[], holdMs: number, status = 200): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('retry: 1\n\n'));
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      setTimeout(() => controller.close(), holdMs);
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
};

/** Mocks POST /exec plus the events stream; `events` decides each cycle's response. */
function mockTransport(events: (attempt: number) => Response): () => number {
  let attempts = 0;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'run-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/run-1/events')) {
      attempts++;
      return events(attempts);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return () => attempts;
}

function run(log?: (level: string, msg: string) => void) {
  return exec(
    { command: 'run', commandLine: 'true', timeoutSeconds: 60 },
    { apiUrl: API_URL, token: 'test-token', ...(log ? { log } : {}) },
  );
}

// A dead event stream (the exec record is gone, or the instance was
// deleted) must exhaust the give-up clock and fail within it, not spin
// until the one-hour completion timeout. The structured reason lets
// callers distinguish this from a genuine completion timeout.
test('a stream that never delivers events gives up after the policy window', async () => {
  sseStreamPolicy.giveUpAfterMs = 200;
  const attempts = mockTransport(() => sseResponse([]));

  const result = await run();

  expect(result.status).toBe('FAILED');
  expect(result.exitCode).toBe(1);
  expect(result.timedOut).toBe(true);
  expect(result.incomplete?.reason).toBe('stream-lost');
  expect(result.incomplete?.message).toContain('may no longer exist');
  expect(attempts()).toBeGreaterThan(2);
});

// A flapping connection that still delivers events must never trip the
// clock: each received event resets it. Every cycle here holds 10ms, so
// the 24 broken cycles span >240ms against a 100ms window; without the
// event reset the run would fail around the tenth cycle.
test('delivered events keep resetting the give-up clock', async () => {
  sseStreamPolicy.giveUpAfterMs = 100;
  const attempts = mockTransport((attempt) =>
    attempt < 25 ?
      heldSseResponse([`event: stdout\ndata: chunk ${attempt}\n\n`], 10)
    : sseResponse(['event: exitCode\ndata: 0\n\n']),
  );

  const result = await run();

  expect(result.status).toBe('SUCCEEDED');
  expect(result.exitCode).toBe(0);
  expect(attempts()).toBe(25);
});

// A quiet build behind an idle-killing intermediary: connections stream
// nothing but stay open. Each cleanly held connection counts as proof of
// life, so cycling well past the give-up window must not abort the run.
test('long-lived silent connections keep resetting the give-up clock', async () => {
  sseStreamPolicy.healthyConnectionMs = 30;
  sseStreamPolicy.giveUpAfterMs = 100;
  const attempts = mockTransport((attempt) =>
    attempt < 6 ? heldSseResponse([], 50) : sseResponse(['event: exitCode\ndata: 0\n\n']),
  );

  const result = await run();

  expect(result.status).toBe('SUCCEEDED');
  expect(result.exitCode).toBe(0);
  expect(attempts()).toBe(6);
});

// An error response held open must NOT count as proof of life: only clean
// responses do. Otherwise a dead exec behind a slow intermediary would
// reset the clock every cycle and degrade back into the hour-long hang.
// The give-up error must also name the status instead of speculating.
test('a held-open error response neither resets the clock nor hides its status', async () => {
  sseStreamPolicy.healthyConnectionMs = 30;
  sseStreamPolicy.giveUpAfterMs = 100;
  const attempts = mockTransport(() => heldSseResponse([], 50, 404));

  const result = await run();

  expect(result.status).toBe('FAILED');
  expect(result.timedOut).toBe(true);
  expect(result.incomplete?.reason).toBe('stream-lost');
  expect(result.incomplete?.message).toContain('HTTP 404');
  expect(attempts()).toBeGreaterThan(1);
});

// On HTTP 204 the EventSource closes permanently without scheduling a
// reconnect, so nothing else would ever settle the stream promise. The
// fetch wrapper must detect it and fail immediately instead of hanging
// until the completion timeout.
test('a 204 response fails the execution immediately instead of hanging', async () => {
  const attempts = mockTransport(() => new Response(null, { status: 204 }));

  const result = await run();

  expect(result.status).toBe('FAILED');
  expect(result.exitCode).toBe(1);
  expect(result.timedOut).toBe(true);
  expect(result.incomplete?.reason).toBe('stream-closed');
  expect(attempts()).toBe(1);
});

// A rejected fetch (connection refused, DNS dead) never reaches the
// library's disconnect callback; sseFetch captures it so the give-up error
// names the real cause instead of a generic message.
test('the give-up message carries the last fetch rejection', async () => {
  sseStreamPolicy.giveUpAfterMs = 200;
  const warns: string[] = [];
  mockTransport((attempt) => {
    if (attempt === 1) return sseResponse([]);
    throw new Error('connect ECONNREFUSED 10.0.0.1:443');
  });

  const result = await run((level, msg) => {
    if (level === 'warn') warns.push(msg);
  });

  expect(result.status).toBe('FAILED');
  expect(result.timedOut).toBe(true);
  expect(result.incomplete?.message).toContain('ECONNREFUSED');
  expect(warns.some((msg) => msg.includes('ECONNREFUSED'))).toBe(true);
});
