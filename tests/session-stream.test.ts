import { streamSessionEntries, SessionStreamLostError } from '../src/internal/session-stream';
import { sseStreamPolicy } from '../src/exec-client';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';
import type { SessionLogLine } from '../src';

const STREAM_URL = 'https://ios.example.test/session/applogs/events';

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

// The runtime tags every entry with an SSE id and resumes after the
// Last-Event-ID a reconnect carries; the client must therefore send the last
// id it saw (including ids of frames it skipped as malformed) so no entry is
// delivered twice or lost across a drop. Frames that do not parse to an
// object with a numeric ts must be skipped, not kill the stream.
test('delivers parsed entries in order and resumes with Last-Event-ID on reconnect', async () => {
  const lastEventIds: (string | null)[] = [];
  const authorizations: (string | null)[] = [];
  let attempts = 0;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    attempts++;
    const headers = new Headers(init?.headers);
    lastEventIds.push(headers.get('Last-Event-ID'));
    authorizations.push(headers.get('Authorization'));
    if (attempts === 1) {
      return heldSseResponse(
        [
          'id: 1\ndata: {"ts":1,"line":"a"}\n\n',
          'id: 2\ndata: not-json\n\n',
          'id: 3\ndata: {"line":"no-ts"}\n\n',
          'id: 4\ndata: {"ts":4,"line":"b"}\n\n',
        ],
        10,
      );
    }
    return heldSseResponse(['id: 5\ndata: {"ts":5,"line":"c"}\n\n'], 250);
  });

  const lines: SessionLogLine[] = [];
  let sawThird: () => void;
  const done = new Promise<void>((resolve) => (sawThird = resolve));
  const stop = streamSessionEntries<SessionLogLine>({
    url: STREAM_URL,
    token: 'test-token',
    onEntry: (entry) => {
      lines.push(entry);
      if (lines.length === 3) sawThird();
    },
  });
  await done;
  stop();

  expect(lines.map((line) => line.line)).toEqual(['a', 'b', 'c']);
  expect(authorizations[0]).toBe('Bearer test-token');
  expect(lastEventIds[0]).toBeNull();
  expect(lastEventIds[1]).toBe('4');

  // close() must stop the reconnect loop for good.
  const attemptsAtClose = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(attempts).toBe(attemptsAtClose);
});

// A dead stream (deleted instance) must exhaust the give-up clock, report
// once through onError, and stop reconnecting, instead of retrying silently
// forever.
test('a stream that never delivers entries gives up and closes', async () => {
  sseStreamPolicy.giveUpAfterMs = 150;
  let attempts = 0;
  nodeProxyTransport.fetch = jest.fn(async () => {
    attempts++;
    return sseResponse([]);
  });

  const errors: Error[] = [];
  let failed: () => void;
  const done = new Promise<void>((resolve) => (failed = resolve));
  streamSessionEntries<SessionLogLine>({
    url: STREAM_URL,
    token: 'test-token',
    onEntry: () => {},
    onError: (error) => {
      errors.push(error);
      failed();
    },
  });
  await done;

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(SessionStreamLostError);
  expect(errors[0]!.message).toContain('may no longer exist');
  expect(attempts).toBeGreaterThan(2);

  const attemptsAtFailure = attempts;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(attempts).toBe(attemptsAtFailure);
});

// An error response held open must not count as proof of life, and the
// give-up error must name the status so a deleted instance reads as one.
test('a held-open error response leads to give-up naming the status', async () => {
  sseStreamPolicy.healthyConnectionMs = 30;
  sseStreamPolicy.giveUpAfterMs = 100;
  nodeProxyTransport.fetch = jest.fn(async () => heldSseResponse([], 50, 404));

  const errors: Error[] = [];
  let failed: () => void;
  const done = new Promise<void>((resolve) => (failed = resolve));
  streamSessionEntries<SessionLogLine>({
    url: STREAM_URL,
    token: 'test-token',
    onEntry: () => {},
    onError: (error) => {
      errors.push(error);
      failed();
    },
  });
  await done;

  expect(errors[0]!.message).toContain('HTTP 404');
});
