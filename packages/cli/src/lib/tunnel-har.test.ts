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
    recorder.onGap({
      fromSequence: 3,
      toSequence: 4,
      message: 'Inspection stream gap: missing sequences 3-4',
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
        requestId: 'request-2',
        tunnelId: 'tunnel-2',
      },
    });

    expect(fs.statSync(`${harPath}.partial`).mode & 0o777).toBe(0o600);
    await recorder.finalize();

    expect(fs.existsSync(`${harPath}.partial`)).toBe(false);
    expect(fs.statSync(harPath).mode & 0o777).toBe(0o600);
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].request.postData).toMatchObject({
      text: 'hell',
    });
    expect(har.log.entries[0].response.content).toMatchObject({
      text: 'AAEC',
      encoding: 'base64',
    });
    expect(har.log.entries[0]._limrun).toMatchObject({
      requestBodyTruncated: true,
      responseBodyTruncated: false,
      gap: true,
    });
    expect(har.log._limrun.gaps).toEqual([
      {
        fromSequence: 3,
        toSequence: 4,
        message: 'Inspection stream gap: missing sequences 3-4',
      },
    ]);
    expect(har.log.entries[1]._limrun).toMatchObject({
      requestId: 'request-2',
      tunnelId: 'tunnel-2',
    });
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

  test('formats only the safe one-line completion summary', () => {
    expect(formatInspectionSummary(completeEvent())).toBe(
      'POST https://example.test/full?q=secret 201 25ms 3 B',
    );
    expect(formatInspectionSummary({ ...completeEvent(), error: 'connection reset' })).toBe(
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
    requestId: 'request-1',
    tunnelId: 'tunnel-1',
    selectorId: 'domain-1',
    startedDateTime: '2026-08-29T09:00:00.000Z',
    time: 25,
    request: {
      method: 'POST',
      url: 'https://example.test/full?q=secret',
      httpVersion: 'HTTP/1.1',
      headers: [
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'Cookie', value: 'private=1' },
      ],
      queryString: [{ name: 'q', value: 'secret' }],
      cookies: [{ name: 'private', value: '1' }],
      headersSize: 50,
      bodySize: 5,
      postData: { mimeType: 'text/plain' },
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
    protocol: 'http/1.1',
    tls: true,
  };
}
