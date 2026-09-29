import * as zlib from 'zlib';
import { DestinationTunnelHARAssembler } from '../src/destination-tunnel-har';
import type { DestinationTunnelInspectionComplete } from '../src/destination-tunnel-inspection';

const zstdCompressSync = (zlib as any).zstdCompressSync as ((data: Uint8Array) => Buffer) | undefined;

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

describe('DestinationTunnelHARAssembler content encoding', () => {
  const json = JSON.stringify({ gzipped: true, message: 'héllo wörld ✓' });

  test('decodes gzip JSON response bodies and reports decoded size', () => {
    const wire = zlib.gzipSync(json);
    const entry = responseEntry(wire, 'application/json; charset=utf-8', 'gzip');

    expect(entry.response.content.text).toBe(json);
    expect(entry.response.content.encoding).toBeUndefined();
    expect(entry.response.content.size).toBe(Buffer.byteLength(json));
    expect(entry.response.content.compression).toBe(Buffer.byteLength(json) - wire.byteLength);
    expect(entry.response.headers).toContainEqual({ name: 'Content-Encoding', value: 'gzip' });
  });

  test('decodes brotli HTML response bodies', () => {
    const html = '<!doctype html><title>brötli</title>';
    const entry = responseEntry(zlib.brotliCompressSync(html), 'text/html', 'br');
    expect(entry.response.content.text).toBe(html);
  });

  (zstdCompressSync ? test : test.skip)('decodes zstd JavaScript response bodies', () => {
    const js = 'console.log("zstd ✓");';
    const entry = responseEntry(zstdCompressSync!(Buffer.from(js)), 'application/javascript', 'zstd');
    expect(entry.response.content.text).toBe(js);
  });

  test('decodes zlib-wrapped and raw deflate', () => {
    expect(responseEntry(zlib.deflateSync(json), 'application/json', 'deflate').response.content.text).toBe(
      json,
    );
    expect(
      responseEntry(zlib.deflateRawSync(json), 'application/json', 'deflate').response.content.text,
    ).toBe(json);
  });

  test('undoes stacked encodings in reverse order', () => {
    const wire = zlib.brotliCompressSync(zlib.gzipSync(json));
    const entry = responseEntry(wire, 'application/json', 'gzip, br');
    expect(entry.response.content.text).toBe(json);
  });

  test('falls back to base64 of the raw bytes for truncated gzip bodies', () => {
    const wire = zlib.gzipSync(json.repeat(50));
    const truncated = wire.subarray(0, Math.floor(wire.byteLength / 2));
    const entry = responseEntry(truncated, 'application/json', 'gzip');

    expect(entry.response.content).toMatchObject({
      text: truncated.toString('base64'),
      encoding: 'base64',
      size: 999,
    });
    expect(entry.response.content.compression).toBeUndefined();
  });

  test('keeps raw bytes when a compressed body was truncated at the body limit', () => {
    const wire = zlib.gzipSync(json.repeat(50));
    const limit = Math.floor(wire.byteLength / 2);
    const assembler = new DestinationTunnelHARAssembler(limit);
    const base = completeEntry();
    assembler.add({ type: 'body', sequence: 1, requestId: 'request-1', direction: 'response', body: wire });
    const entry = assembler.add({
      type: 'complete',
      sequence: 2,
      requestId: 'request-1',
      data: {
        ...base,
        response: {
          ...base.response,
          headers: [{ name: 'Content-Encoding', value: 'gzip' }],
          content: { size: 999, mimeType: 'application/json' },
        },
      },
    });

    expect(entry?.response.content).toMatchObject({
      text: wire.subarray(0, limit).toString('base64'),
      encoding: 'base64',
    });
    expect(entry?._limrun.responseBodyTruncated).toBe(true);
  });

  test('falls back to base64 of the raw bytes for unknown encodings', () => {
    const wire = Buffer.from('not really compressed');
    const entry = responseEntry(wire, 'text/plain', 'compress');
    expect(entry.response.content).toMatchObject({ text: wire.toString('base64'), encoding: 'base64' });
  });

  test('encodes non-UTF-8 bytes under a textual type as base64', () => {
    const bytes = Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x00]);
    const entry = responseEntry(bytes, 'text/plain', undefined);
    expect(entry.response.content).toMatchObject({ text: bytes.toString('base64'), encoding: 'base64' });
  });

  test('encodes decompressed non-UTF-8 bytes under a textual type as base64', () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0xff, 0x00]);
    const entry = responseEntry(zlib.gzipSync(bytes), 'application/json', 'gzip');
    expect(entry.response.content).toMatchObject({
      text: bytes.toString('base64'),
      encoding: 'base64',
      size: bytes.byteLength,
    });
  });

  test('keeps uncompressed images as base64', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const entry = responseEntry(png, 'image/png', undefined);
    expect(entry.response.content).toMatchObject({
      text: png.toString('base64'),
      encoding: 'base64',
      size: 999,
    });
  });

  test('decodes compressed request bodies', () => {
    const assembler = new DestinationTunnelHARAssembler();
    const base = completeEntry();
    assembler.add({
      type: 'body',
      sequence: 1,
      requestId: 'request-1',
      direction: 'request',
      body: zlib.gzipSync(json),
    });
    const entry = assembler.add({
      type: 'complete',
      sequence: 2,
      requestId: 'request-1',
      data: {
        ...base,
        request: {
          ...base.request,
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Content-Encoding', value: 'gzip' },
          ],
        },
      },
    });

    expect(entry?.request.postData).toEqual({ mimeType: 'application/json', text: json });
    expect(entry?._limrun.requestBodyEncoding).toBeUndefined();
  });
});

function responseEntry(body: Uint8Array, mimeType: string, contentEncoding: string | undefined) {
  const assembler = new DestinationTunnelHARAssembler();
  const base = completeEntry();
  assembler.add({ type: 'body', sequence: 1, requestId: 'request-1', direction: 'response', body });
  const entry = assembler.add({
    type: 'complete',
    sequence: 2,
    requestId: 'request-1',
    data: {
      ...base,
      response: {
        ...base.response,
        headers: [
          { name: 'Content-Type', value: mimeType },
          ...(contentEncoding === undefined ? [] : [{ name: 'Content-Encoding', value: contentEncoding }]),
        ],
        content: { size: 999, mimeType },
      },
    },
  });
  if (!entry) throw new Error('expected a HAR entry');
  return entry;
}

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
