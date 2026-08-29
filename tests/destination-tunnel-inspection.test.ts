import net from 'net';
import { WebSocketServer } from 'ws';
import {
  decodeDestinationTunnelInspectionBodyFrame,
  decodeDestinationTunnelInspectionMetadataFrame,
  deriveDestinationTunnelInspectionURL,
  startDestinationTunnelInspectionStream,
  type DestinationTunnelInspectionEvent,
} from '../src/destination-tunnel-inspection';
import { DestinationTunnelProtocolError } from '../src/destination-tunnel';
import { nodeProxyTransport } from '../src/internal/proxy-transport';

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('destination tunnel inspection stream', () => {
  test('derives an encoded authenticated resume URL', () => {
    expect(deriveDestinationTunnelInspectionURL('wss://device.example/base/tunnel', 'id/one', 42)).toBe(
      'wss://device.example/base/tunnel/id%2Fone/inspection?after-sequence=42',
    );
  });

  test('validates binary framing and JavaScript-safe uint64 sequences', () => {
    const requestId = Buffer.from('request-1');
    const frame = Buffer.alloc(12 + requestId.length + 4);
    frame[0] = 1;
    frame.writeBigUInt64BE(23n, 1);
    frame.writeUInt16BE(requestId.length, 9);
    frame[11] = 2;
    requestId.copy(frame, 12);
    frame.write('body', 12 + requestId.length);
    expect(decodeDestinationTunnelInspectionBodyFrame(frame)).toEqual({
      type: 'body',
      sequence: 23,
      requestId: 'request-1',
      direction: 'response',
      body: Buffer.from('body'),
    });

    frame.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1);
    expect(() => decodeDestinationTunnelInspectionBodyFrame(frame)).toThrow(
      'inspection binary sequence exceeds JavaScript safe integer range',
    );
    expect(() => decodeDestinationTunnelInspectionBodyFrame(Buffer.from([1]))).toThrow(
      DestinationTunnelProtocolError,
    );
  });

  test('validates complete metadata instead of passing through arbitrary JSON', () => {
    const complete = completeFrame(7);
    expect(decodeDestinationTunnelInspectionMetadataFrame(JSON.stringify(complete))).toEqual(complete);
    expect(() =>
      decodeDestinationTunnelInspectionMetadataFrame(
        JSON.stringify({ ...complete, sequence: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).toThrow('inspection sequence must be a safe non-negative integer');
    expect(() =>
      decodeDestinationTunnelInspectionMetadataFrame(
        JSON.stringify({ ...complete, data: { ...complete.data, request: { method: 'GET' } } }),
      ),
    ).toThrow(DestinationTunnelProtocolError);
  });

  test('accepts Go nil response slices on pre-response failures', () => {
    const complete = completeFrame(8);
    const decoded = decodeDestinationTunnelInspectionMetadataFrame(
      JSON.stringify({
        ...complete,
        data: {
          ...complete.data,
          error: 'dial failed',
          response: {
            ...complete.data.response,
            status: 0,
            headers: null,
            cookies: null,
          },
        },
      }),
    );
    expect(decoded.type).toBe('complete');
    if (decoded.type !== 'complete') throw new Error('expected complete');
    expect(decoded.data.response.headers).toEqual([]);
    expect(decoded.data.response.cookies).toEqual([]);
    expect(decoded.data.error).toBe('dial failed');
  });

  test('reconnects independently, resumes, and surfaces an explicit gap', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as net.AddressInfo;
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const events: DestinationTunnelInspectionEvent[] = [];
    const gaps: string[] = [];
    const agent = jest.spyOn(nodeProxyTransport, 'getWebSocketAgent');
    let connections = 0;
    server.on('connection', (socket, request) => {
      connections++;
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      if (connections === 1) {
        socket.send(JSON.stringify(errorFrame(1)), () => socket.close());
        return;
      }
      socket.send(
        JSON.stringify({
          sequence: 2,
          type: 'gap',
          data: { fromSequence: 2, toSequence: 2 },
        }),
      );
      socket.send(JSON.stringify(errorFrame(3)));
    });

    const stream = startDestinationTunnelInspectionStream(
      `ws://127.0.0.1:${address.port}/tunnel`,
      'tunnel/1',
      'instance-token',
      {
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 20,
        onEvent: (event) => events.push(event),
        onGap: (gap) => gaps.push(gap.message),
      },
    );
    try {
      await waitFor(() => events.some((event) => event.sequence === 3));
      expect(requests).toEqual([
        {
          url: '/tunnel/tunnel%2F1/inspection?after-sequence=0',
          authorization: 'Bearer instance-token',
        },
        {
          url: '/tunnel/tunnel%2F1/inspection?after-sequence=1',
          authorization: 'Bearer instance-token',
        },
      ]);
      expect(events.map((event) => [event.type, event.sequence])).toEqual([
        ['inspection_error', 1],
        ['gap', 2],
        ['inspection_error', 3],
      ]);
      expect(gaps).toEqual(['Inspection stream gap: missing sequences 2-2']);
      expect(agent).toHaveBeenCalledWith(
        expect.stringContaining('/tunnel/tunnel%2F1/inspection?after-sequence='),
      );
    } finally {
      stream.close();
      agent.mockRestore();
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

function completeFrame(sequence: number) {
  return {
    sequence,
    type: 'complete' as const,
    requestId: 'request-1',
    data: {
      requestId: 'request-1',
      tunnelId: 'tunnel-1',
      selectorId: 'domain-1',
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
        postData: { mimeType: 'text/plain' },
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
      protocol: 'http/1.1',
      tls: true,
    },
  };
}
