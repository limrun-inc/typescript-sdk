import { exec } from '../src/exec-client';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const API_URL = 'https://xcode.example.test';
const OPTIONS = { apiUrl: API_URL, token: 'test-token' };

const originalFetch = nodeProxyTransport.fetch;

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.restoreAllMocks();
});

/**
 * A one-shot SSE response streaming the given frames, then closing. The
 * `retry: 1` frame drops the client's reconnect delay to 1ms so reconnect
 * cycles are fast under test.
 */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('retry: 1\n\n'));
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Mocks POST /exec plus the events stream; `events` decides each cycle's response. */
function mockTransport(events: (attempt: number) => Response): { eventsAttempts: () => number } {
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
  return { eventsAttempts: () => attempts };
}

// A dead event stream (the exec record is gone, or the instance was deleted)
// must exhaust the reconnect budget and fail within seconds, not spin until
// the one-hour completion timeout. This pins the budget: exactly
// SSE_MAX_FAILED_CYCLES connections, then a fabricated timedOut failure.
test('a stream that never delivers events gives up after the reconnect budget', async () => {
  const transport = mockTransport(() => sseResponse([]));

  const result = await exec({ command: 'run', commandLine: 'true', timeoutSeconds: 60 }, OPTIONS);

  expect(result.status).toBe('FAILED');
  expect(result.exitCode).toBe(1);
  expect(result.timedOut).toBe(true);
  expect(transport.eventsAttempts()).toBe(20);
});

// A flapping connection that still delivers events must never trip the
// budget: each received message refills it. 25 broken cycles (more than the
// budget) each carry one event; the run must still reach its exit code.
test('messages reset the reconnect budget across broken connections', async () => {
  const transport = mockTransport((attempt) =>
    attempt < 25 ?
      sseResponse([`event: stdout\ndata: chunk ${attempt}\n\n`])
    : sseResponse(['event: exitCode\ndata: 0\n\n']),
  );

  const result = await exec({ command: 'run', commandLine: 'true', timeoutSeconds: 60 }, OPTIONS);

  expect(result.status).toBe('SUCCEEDED');
  expect(result.exitCode).toBe(0);
  expect(transport.eventsAttempts()).toBe(25);
});

// On HTTP 204 the EventSource closes permanently without scheduling a
// reconnect, so nothing else would ever settle the stream promise. The
// client must detect the close and fail immediately instead of hanging
// until the completion timeout.
test('a 204 response fails the execution immediately instead of hanging', async () => {
  const transport = mockTransport(() => new Response(null, { status: 204 }));

  const result = await exec({ command: 'run', commandLine: 'true', timeoutSeconds: 60 }, OPTIONS);

  expect(result.status).toBe('FAILED');
  expect(result.exitCode).toBe(1);
  expect(result.timedOut).toBe(true);
  expect(transport.eventsAttempts()).toBe(1);
});
