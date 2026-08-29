import { DestinationTunnelHARAssembler } from '../src/destination-tunnel-har';
import type { DestinationTunnelInspectionComplete } from '../src/destination-tunnel-inspection';

describe('DestinationTunnelHARAssembler', () => {
  test('correlates bounded body chunks without filesystem APIs', () => {
    const assembler = new DestinationTunnelHARAssembler(4);
    assembler.add({
      type: 'body',
      sequence: 1,
      requestId: 'request-1',
      direction: 'request',
      body: Buffer.from('hello'),
    });
    assembler.add({
      type: 'body',
      sequence: 2,
      requestId: 'request-1',
      direction: 'response',
      body: Buffer.from([0, 1, 2]),
    });

    const entry = assembler.add({
      type: 'complete',
      sequence: 3,
      requestId: 'request-1',
      data: completeEntry(),
    });

    expect(entry?.request.postData).toEqual({
      mimeType: 'text/plain',
      text: 'hell',
    });
    expect(entry?.response.content).toMatchObject({
      text: 'AAEC',
      encoding: 'base64',
    });
    expect(entry?._limrun).toMatchObject({
      requestBodyTruncated: true,
      responseBodyTruncated: false,
    });
  });
});

function completeEntry(): DestinationTunnelInspectionComplete {
  return {
    startedDateTime: '2026-08-29T09:00:00.000Z',
    time: 10,
    request: {
      method: 'POST',
      url: 'https://example.test/',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      queryString: [],
      cookies: [],
      headersSize: 20,
      bodySize: 5,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [],
      cookies: [],
      content: { size: 3, mimeType: 'application/octet-stream' },
      redirectURL: '',
      headersSize: 0,
      bodySize: 3,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 9, receive: 1 },
    _limrun: { tunnelId: 'tunnel-1', selectorId: 'selector-1' },
  };
}
