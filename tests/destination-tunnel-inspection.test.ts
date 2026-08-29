import net from 'net';
import http from 'http';
import {
  decodeDestinationTunnelInspectionSSEEvent,
  deriveDestinationTunnelInspectionURL,
  startDestinationTunnelInspectionStream,
  type DestinationTunnelInspectionEvent,
} from '../src/destination-tunnel-inspection';
import { DestinationTunnelProtocolError } from '../src/destination-tunnel';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('destination tunnel inspection stream', () => {
  test('derives an encoded browser-compatible authenticated resume URL', () => {
    expect(
      deriveDestinationTunnelInspectionURL('wss://device.example/base/tunnel', 'id/one', 42, 'token /one'),
    ).toBe(
      'https://device.example/base/tunnel/id%2Fone/inspection/events?after-sequence=42&token=token+%2Fone',
    );
    expect(
      deriveDestinationTunnelInspectionURL('wss://device.example/base/tunnel', 'id/one', 'token /one'),
    ).toBe('https://device.example/base/tunnel/id%2Fone/inspection/events?token=token+%2Fone');
  });

  test('decodes base64 SSE body envelopes using the SSE ID as sequence', () => {
    expect(
      decodeDestinationTunnelInspectionSSEEvent(
        '23',
        JSON.stringify({
          sequence: 23,
          type: 'body',
          requestId: 'request-1',
          data: { direction: 'response', encoding: 'base64', chunk: 'Ym9keQ==' },
        }),
      ),
    ).toEqual({
      type: 'body',
      sequence: 23,
      requestId: 'request-1',
      direction: 'response',
      body: new Uint8Array([98, 111, 100, 121]),
    });
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        '24',
        JSON.stringify({
          sequence: 23,
          type: 'body',
          requestId: 'request-1',
          data: { direction: 'request', encoding: 'base64', chunk: 'Ym9keQ==' },
        }),
      ),
    ).toThrow('inspection SSE event ID does not match envelope sequence');
  });

  test('validates complete envelope and core HAR objects without reconstructing entries', () => {
    const complete = completeFrame(7);
    expect(decodeDestinationTunnelInspectionSSEEvent('7', JSON.stringify(complete))).toEqual(complete);
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        String(Number.MAX_SAFE_INTEGER + 1),
        JSON.stringify({ ...complete, sequence: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).toThrow('inspection sequence must be a safe non-negative integer');
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        '7',
        JSON.stringify({ ...complete, data: { ...complete.data, request: { method: 'GET' } } }),
      ),
    ).toThrow(DestinationTunnelProtocolError);
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        '7',
        JSON.stringify({
          ...complete,
          data: {
            ...complete.data,
            response: {
              ...complete.data.response,
              content: { size: 2 },
            },
          },
        }),
      ),
    ).toThrow('mimeType must be a string');
    const withExtension = {
      ...complete,
      data: { ...complete.data, futureHarField: 'retained' },
    };
    expect(decodeDestinationTunnelInspectionSSEEvent('7', JSON.stringify(withExtension))).toEqual(
      withExtension,
    );
  });

  test.each(['request', 'response'])('rejects removed %s metadata events', (type) => {
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        '1',
        JSON.stringify({ sequence: 1, type, requestId: 'request-1', data: {} }),
      ),
    ).toThrow(`unknown inspection metadata type ${type}`);
  });

  test('rejects non-HAR response slices', () => {
    const complete = completeFrame(8);
    expect(() =>
      decodeDestinationTunnelInspectionSSEEvent(
        '8',
        JSON.stringify({
          ...complete,
          data: {
            ...complete.data,
            _limrun: { ...complete.data._limrun, error: 'dial failed' },
            response: {
              ...complete.data.response,
              status: 0,
              headers: null,
              cookies: null,
            },
          },
        }),
      ),
    ).toThrow('response headers must be an array');
  });

  test('reconnects independently, resumes, and surfaces an explicit gap', async () => {
    const requests: Array<{
      url: string | undefined;
      authorization: string | undefined;
      lastEventId: string | undefined;
    }> = [];
    const events: DestinationTunnelInspectionEvent[] = [];
    let connections = 0;
    const server = http.createServer((request, response) => {
      connections++;
      const lastEventId = request.headers['last-event-id'];
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        lastEventId: Array.isArray(lastEventId) ? lastEventId[0] : lastEventId,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (connections === 1) {
        writeSSE(response, 1, errorFrame(1), 10);
        response.end();
        return;
      }
      writeSSE(
        response,
        2,
        {
          sequence: 2,
          type: 'gap',
          data: { fromSequence: 2, toSequence: 2 },
        },
        10,
      );
      writeSSE(response, 3, errorFrame(3));
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as net.AddressInfo;

    const stream = startDestinationTunnelInspectionStream(
      `http://127.0.0.1:${address.port}/tunnel`,
      'tunnel/1',
      'instance-token',
      {
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 20,
        onEvent: (event) => events.push(event),
      },
    );
    try {
      await waitFor(() => events.some((event) => event.sequence === 3));
      expect(requests).toEqual([
        {
          url: '/tunnel/tunnel%2F1/inspection/events?token=instance-token',
          authorization: undefined,
          lastEventId: undefined,
        },
        {
          url: '/tunnel/tunnel%2F1/inspection/events?token=instance-token',
          authorization: undefined,
          lastEventId: '1',
        },
      ]);
      expect(events.map((event) => [event.type, event.sequence])).toEqual([
        ['inspection_error', 1],
        ['gap', 2],
        ['inspection_error', 3],
      ]);
      expect(events[1]).toMatchObject({
        type: 'gap',
        data: { message: 'Inspection stream gap: missing sequences 2-2' },
      });
    } finally {
      stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function errorFrame(sequence: number) {
  return {
    sequence,
    type: 'inspection_error',
    data: { message: 'diagnostic' },
  };
}

function writeSSE(response: http.ServerResponse, id: number, data: unknown, retry?: number): void {
  if (retry !== undefined) response.write(`retry: ${retry}\n`);
  response.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

function completeFrame(sequence: number) {
  return {
    sequence,
    type: 'complete' as const,
    requestId: 'request-1',
    data: {
      startedDateTime: '2026-08-29T09:00:00.000Z',
      time: 12,
      request: {
        method: 'POST',
        url: 'https://example.test/path?q=1',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
        queryString: [{ name: 'q', value: '1' }],
        cookies: [],
        headersSize: 30,
        bodySize: 4,
        postData: { mimeType: 'text/plain', text: 'body' },
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        cookies: [],
        content: { size: 2, mimeType: 'application/octet-stream' },
        redirectURL: '',
        headersSize: 2,
        bodySize: 2,
      },
      cache: {},
      timings: { blocked: 0, dns: 1, connect: 2, ssl: 3, send: 1, wait: 4, receive: 1 },
      _limrun: {
        tunnelId: 'tunnel-1',
        selectorId: 'selector-1',
        responseTrailers: [{ name: 'grpc-status', value: '0' }],
        responseCookieSameSite: [{ index: 0, value: 'Lax' }],
      },
    },
  };
}
