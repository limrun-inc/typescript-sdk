import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DestinationTunnelInspectionComplete, DestinationTunnelInspectionEvent } from '@limrun/api';
import { createTunnelHarRecorder, formatInspectionSummary } from './tunnel-har';

describe('tunnel HAR capture', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-har-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('spools bounded bodies and atomically finalizes HAR 1.2', async () => {
    const harPath = path.join(directory, 'traffic.har');
    const recorder = createTunnelHarRecorder(harPath, 4);
    recorder.onEvent(bodyEvent(1, 'request', Buffer.from('hello')));
    recorder.onEvent(bodyEvent(2, 'response', Buffer.from([0, 1, 2])));
    recorder.onEvent({
      type: 'gap',
      sequence: 4,
      data: {
        fromSequence: 3,
        toSequence: 4,
        message: 'Inspection stream gap: missing sequences 3-4',
      },
    });
    recorder.onEvent({
      type: 'complete',
      sequence: 5,
      requestId: 'request-1',
      data: completeEvent(),
    });
    recorder.onEvent({
      type: 'complete',
      sequence: 6,
      requestId: 'request-2',
      data: {
        ...completeEvent(),
        _limrun: {
          ...completeEvent()._limrun,
          tunnelId: 'tunnel-2',
        },
      },
    });

    expect(fs.statSync(`${harPath}.partial`).mode & 0o777).toBe(0o600);
    await recorder.finalize();

    expect(fs.existsSync(`${harPath}.partial`)).toBe(false);
    expect(fs.statSync(harPath).mode & 0o777).toBe(0o600);
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].request.postData).toEqual({
      mimeType: 'application/octet-stream',
      text: 'aGVsbA==',
    });
    expect(har.log.entries[0].request.postData).not.toHaveProperty('_encoding');
    expect(har.log.entries[0].response.content).toEqual({
      size: 3,
      mimeType: 'application/octet-stream',
      text: 'AAEC',
      encoding: 'base64',
    });
    expect(har.log.entries[0].response).not.toHaveProperty('trailers');
    expect(har.log.entries[0].response).not.toHaveProperty('_trailers');
    expect(har.log.entries[0].response.cookies[0]).not.toHaveProperty('sameSite');
    expect(har.log.entries[0]._limrun).toEqual({
      tunnelId: 'tunnel-1',
      selectorId: 'domain-1',
      responseTrailers: [{ name: 'grpc-status', value: '0' }],
      responseCookieSameSite: [{ index: 0, value: 'Strict' }],
      requestBodyEncoding: 'base64',
      requestBodyTruncated: true,
      responseBodyTruncated: false,
    });
    expect(har.log._limrun.gaps).toEqual([
      {
        fromSequence: 3,
        toSequence: 4,
        message: 'Inspection stream gap: missing sequences 3-4',
      },
    ]);
    expect(har.log.entries[1]._limrun).toMatchObject({
      tunnelId: 'tunnel-2',
    });
  });

  test('drops incomplete body state between tunnel generations', async () => {
    const harPath = path.join(directory, 'reconnected.har');
    const recorder = createTunnelHarRecorder(harPath, 1024);
    recorder.onEvent(bodyEvent(1, 'request', Buffer.from('old generation')));
    recorder.resetPending();
    recorder.onEvent({
      type: 'complete',
      sequence: 2,
      requestId: 'request-1',
      data: completeEvent(),
    });

    await recorder.finalize();
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    expect(har.log.entries[0].request.postData.text).toBe('original body');
  });

  test('recovers complete records before a torn final partial record', async () => {
    const harPath = path.join(directory, 'recovered.har');
    fs.writeFileSync(
      `${harPath}.partial`,
      '{"type":"entry","entry":{"startedDateTime":"2026-01-01T00:00:00Z"}}\n{"type":"entry"',
      { mode: 0o644 },
    );
    const recorder = createTunnelHarRecorder(harPath, 1);
    await recorder.finalize();
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    expect(har.log.entries).toEqual([{ startedDateTime: '2026-01-01T00:00:00Z' }]);
    expect(fs.statSync(harPath).mode & 0o777).toBe(0o600);
  });

  test('formats only the one-line completion summary', () => {
    expect(formatInspectionSummary(completeEvent())).toBe(
      'POST https://example.test/full?q=secret 201 25ms 3 B',
    );
    const failed = completeEvent();
    failed._limrun.error = 'connection reset';
    expect(formatInspectionSummary(failed)).toBe(
      'POST https://example.test/full?q=secret ERROR connection reset 25ms 3 B',
    );
  });
});

function bodyEvent(
  sequence: number,
  direction: 'request' | 'response',
  body: Buffer,
): DestinationTunnelInspectionEvent {
  return { type: 'body', sequence, requestId: 'request-1', direction, body };
}

function completeEvent(): DestinationTunnelInspectionComplete {
  return {
    startedDateTime: '2026-08-29T09:00:00.000Z',
    time: 25,
    request: {
      method: 'POST',
      url: 'https://example.test/full?q=secret',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'Cookie', value: 'private=1' },
      ],
      queryString: [{ name: 'q', value: 'secret' }],
      cookies: [{ name: 'private', value: '1' }],
      headersSize: 50,
      bodySize: 5,
      postData: { mimeType: 'application/octet-stream', text: 'original body' },
    },
    response: {
      status: 201,
      statusText: 'Created',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Set-Cookie', value: 'private=2' }],
      cookies: [{ name: 'private', value: '2' }],
      content: { size: 3, mimeType: 'application/octet-stream' },
      redirectURL: '',
      headersSize: 20,
      bodySize: 3,
    },
    cache: {},
    timings: { blocked: 0, dns: 1, connect: 2, ssl: 3, send: 4, wait: 10, receive: 5 },
    _limrun: {
      tunnelId: 'tunnel-1',
      selectorId: 'domain-1',
      responseTrailers: [{ name: 'grpc-status', value: '0' }],
      responseCookieSameSite: [{ index: 0, value: 'Strict' }],
    },
  };
}
