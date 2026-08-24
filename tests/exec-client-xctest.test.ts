import { exec, type XctestEvent } from '../src/exec-client';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const API_URL = 'https://xcode.example.test';

const originalFetch = nodeProxyTransport.fetch;

afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.restoreAllMocks();
});

const frame = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;

const passCase =
  '{"type":"case","testClass":"AppTests.LoginTests","method":"testValid","passed":true,"durationMs":312}';
const failCase =
  '{"type":"case","testClass":"AppTests.LoginTests","method":"testExpired","passed":false,"durationMs":95,"failureMessage":"XCTAssertEqual failed"}';
const summary = '{"type":"summary","passed":1,"failed":1,"planFinished":true}';

/** Mocks POST /exec plus a one-shot events stream carrying the given frames. */
function mockTransport(frames: string[], capture?: (body: unknown) => void) {
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/exec')) {
      capture?.(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ execId: 'run-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/exec/run-1/events')) {
      return new Response('retry: 1\n\n' + frames.join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

test('streams xctest events to the callback and accumulates them on the result', async () => {
  mockTransport([
    frame('xctest', passCase),
    frame('xctest', failCase),
    frame('xctest', summary),
    frame('exitCode', '1'),
  ]);
  const seen: XctestEvent[] = [];

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    { apiUrl: API_URL, token: 'test-token', onXctestEvent: (event) => seen.push(event) },
  );

  expect(seen).toHaveLength(3);
  expect(result.exitCode).toBe(1);
  expect(result.xctest?.cases.map((c) => c.method)).toEqual(['testValid', 'testExpired']);
  expect(result.xctest?.cases[1]?.failureMessage).toBe('XCTAssertEqual failed');
  expect(result.xctest?.summary).toMatchObject({ passed: 1, failed: 1, planFinished: true });
});

test('a malformed xctest frame is tolerated and the rest of the run stands', async () => {
  mockTransport([frame('xctest', 'not json'), frame('xctest', summary), frame('exitCode', '0')]);

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    { apiUrl: API_URL, token: 'test-token' },
  );

  expect(result.exitCode).toBe(0);
  expect(result.xctest?.cases).toEqual([]);
  expect(result.xctest?.summary).toMatchObject({ planFinished: true });
});

test('a run that dies before the summary leaves it absent, not fabricated', async () => {
  mockTransport([frame('xctest', passCase), frame('exitCode', '1')]);

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    { apiUrl: API_URL, token: 'test-token' },
  );

  expect(result.xctest?.cases).toHaveLength(1);
  expect(result.xctest?.summary).toBeUndefined();
});

test('a plain build reports no xctest field at all', async () => {
  mockTransport([frame('stdout', 'Build succeeded'), frame('exitCode', '0')]);

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App' } },
    { apiUrl: API_URL, token: 'test-token' },
  );

  expect(result.xctest).toBeUndefined();
});

test('a reconnect replaying the stream does not double-count cases or re-fire the callback', async () => {
  // The server replays every event from the start on reconnect; only exitCode
  // ends the stream, so a mid-suite disconnect means a full replay.
  let attempts = 0;
  nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/exec')) {
      return new Response(JSON.stringify({ execId: 'run-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    attempts++;
    const frames =
      attempts === 1 ?
        [frame('xctest', passCase), frame('xctest', failCase)]
      : [
          frame('xctest', passCase),
          frame('xctest', failCase),
          frame('xctest', summary),
          frame('exitCode', '1'),
        ];
    return new Response('retry: 1\n\n' + frames.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const seen: XctestEvent[] = [];

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    { apiUrl: API_URL, token: 'test-token', onXctestEvent: (event) => seen.push(event) },
  );

  expect(attempts).toBeGreaterThan(1);
  expect(result.xctest?.cases).toHaveLength(2);
  expect(seen).toHaveLength(3);
  expect(result.xctest?.summary).toMatchObject({ passed: 1, failed: 1 });
});

test('a throwing callback does not derail the run', async () => {
  mockTransport([frame('xctest', passCase), frame('xctest', summary), frame('exitCode', '0')]);
  const warnings: string[] = [];

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    {
      apiUrl: API_URL,
      token: 'test-token',
      log: (level, msg) => level === 'warn' && warnings.push(msg),
      onXctestEvent: () => {
        throw new Error('consumer bug');
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.xctest?.cases).toHaveLength(1);
  expect(warnings.some((w) => w.includes('callback threw'))).toBe(true);
});

test('an unknown frame type is ignored, not forwarded to the callback', async () => {
  mockTransport([frame('xctest', '{"type":"start"}'), frame('xctest', summary), frame('exitCode', '0')]);
  const seen: XctestEvent[] = [];

  const result = await exec(
    { command: 'xcodebuild', xcodebuild: { scheme: 'App', action: 'build-for-testing' } },
    { apiUrl: API_URL, token: 'test-token', onXctestEvent: (event) => seen.push(event) },
  );

  expect(seen.map((e) => e.type)).toEqual(['summary']);
  expect(result.xctest?.cases).toEqual([]);
});

test('action and test selection reach the wire verbatim', async () => {
  let body: unknown;
  mockTransport([frame('exitCode', '0')], (b) => (body = b));

  await exec(
    {
      command: 'xcodebuild',
      xcodebuild: {
        scheme: 'App',
        action: 'build-for-testing',
        onlyTesting: ['AppTests/LoginTests/testValid'],
      },
    },
    { apiUrl: API_URL, token: 'test-token' },
  );

  expect(body).toMatchObject({
    xcodebuild: { action: 'build-for-testing', onlyTesting: ['AppTests/LoginTests/testValid'] },
  });
});
