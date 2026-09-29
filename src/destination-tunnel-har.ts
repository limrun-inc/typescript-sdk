import type { Entry as HAREntry, Request as HARRequest, Response as HARResponse } from 'har-format';
import * as zlib from 'zlib';
import { DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES } from './destination-tunnel';
import type {
  DestinationTunnelInspectionComplete,
  DestinationTunnelInspectionEvent,
  DestinationTunnelInspectionExtension,
} from './destination-tunnel-inspection';

interface PendingCapture {
  requestBody: Uint8Array[];
  requestBytes: number;
  requestTruncated: boolean;
  responseBody: Uint8Array[];
  responseBytes: number;
  responseTruncated: boolean;
}

export type DestinationTunnelHARExtension = DestinationTunnelInspectionExtension & {
  requestBodyEncoding?: 'base64';
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
};

export type DestinationTunnelHAREntry = HAREntry & {
  _limrun: DestinationTunnelHARExtension;
};

/**
 * Correlates filesystem-neutral inspection body chunks with completion
 * metadata and returns self-contained HAR entries.
 */
export class DestinationTunnelHARAssembler {
  private readonly pending = new Map<string, PendingCapture>();

  constructor(readonly bodyLimit: number = DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES) {
    if (!Number.isInteger(bodyLimit) || bodyLimit < 1) {
      throw new Error('HAR body limit must be a positive integer');
    }
  }

  add(event: DestinationTunnelInspectionEvent): DestinationTunnelHAREntry | undefined {
    if (event.type === 'body') {
      const state = this.stateFor(event.requestId);
      const response = event.direction === 'response';
      const bytes = response ? state.responseBytes : state.requestBytes;
      const take = Math.min(event.body.byteLength, Math.max(0, this.bodyLimit - bytes));
      if (take > 0) {
        (response ? state.responseBody : state.requestBody).push(event.body.slice(0, take));
      }
      if (response) {
        state.responseBytes += take;
        state.responseTruncated ||= take < event.body.byteLength;
      } else {
        state.requestBytes += take;
        state.requestTruncated ||= take < event.body.byteLength;
      }
      return undefined;
    }
    if (event.type !== 'complete') return undefined;

    const state = this.stateFor(event.requestId);
    try {
      return makeDestinationTunnelHAREntry(event.data, state);
    } finally {
      this.pending.delete(event.requestId);
    }
  }

  reset(): void {
    this.pending.clear();
  }

  private stateFor(requestId: string): PendingCapture {
    let state = this.pending.get(requestId);
    if (!state) {
      state = {
        requestBody: [],
        requestBytes: 0,
        requestTruncated: false,
        responseBody: [],
        responseBytes: 0,
        responseTruncated: false,
      };
      this.pending.set(requestId, state);
    }
    return state;
  }
}

function makeDestinationTunnelHAREntry(
  complete: DestinationTunnelInspectionComplete,
  capture: PendingCapture,
): DestinationTunnelHAREntry {
  const requestBody = concatBytes(capture.requestBody, capture.requestBytes);
  const responseBody = concatBytes(capture.responseBody, capture.responseBytes);
  const requestTruncated = complete._limrun.requestBodyTruncated === true || capture.requestTruncated;
  const responseTruncated = complete._limrun.responseBodyTruncated === true || capture.responseTruncated;
  const { request, encoding: requestBodyEncoding } = addRequestBody(
    complete.request,
    requestBody,
    requestTruncated,
  );
  const response = addResponseBody(complete.response, responseBody, responseTruncated);
  return {
    ...(complete.pageref === undefined ? {} : { pageref: complete.pageref }),
    startedDateTime: complete.startedDateTime,
    time: complete.time,
    request,
    response,
    cache: complete.cache,
    timings: complete.timings,
    ...(complete.serverIPAddress === undefined ? {} : { serverIPAddress: complete.serverIPAddress }),
    ...(complete.connection === undefined ? {} : { connection: complete.connection }),
    ...(complete.comment === undefined ? {} : { comment: complete.comment }),
    _limrun: {
      ...complete._limrun,
      ...(requestBodyEncoding ? { requestBodyEncoding } : {}),
      requestBodyTruncated: requestTruncated,
      responseBodyTruncated: responseTruncated,
    },
  };
}

function addRequestBody(
  request: HARRequest,
  body: Uint8Array,
  truncated: boolean,
): { request: HARRequest; encoding?: 'base64' } {
  if (body.byteLength === 0) return { request };
  const mimeType = request.postData?.mimeType ?? headerValue(request.headers, 'content-type');
  const encoded = encodedBody(body, mimeType, headerValue(request.headers, 'content-encoding'), truncated);
  return {
    request: {
      ...request,
      postData: {
        mimeType: mimeType ?? '',
        text: encoded.text,
      },
    },
    ...(encoded.encoding ? { encoding: encoded.encoding } : {}),
  };
}

function addResponseBody(response: HARResponse, body: Uint8Array, truncated: boolean): HARResponse {
  if (body.byteLength === 0) return response;
  const content = { ...response.content };
  delete content.text;
  delete content.encoding;
  const { decodedSize, ...encoded } = encodedBody(
    body,
    response.content.mimeType,
    headerValue(response.headers, 'content-encoding'),
    truncated,
  );
  return {
    ...response,
    content: {
      ...content,
      ...(decodedSize === undefined ? {} : { size: decodedSize, compression: decodedSize - body.byteLength }),
      ...encoded,
    },
  };
}

/**
 * Renders a captured body as HAR text. Content-Encoding is undone first so
 * the HAR holds the decoded body, as HAR 1.2 and browser exports do. Anything
 * that cannot be represented losslessly as UTF-8 text (unknown or corrupt
 * encodings, truncated compressed bodies, non-UTF-8 bytes under a textual
 * type) falls back to base64 of the bytes rather than lossy text.
 *
 * `decodedSize` is set only when a Content-Encoding was successfully removed.
 */
function encodedBody(
  body: Uint8Array,
  contentType: string | undefined,
  contentEncoding: string | undefined,
  truncated: boolean,
): { text: string; encoding?: 'base64'; decodedSize?: number } {
  let decoded = body;
  let decodedSize: number | undefined;
  const codings = parseContentEncoding(contentEncoding);
  if (codings.length > 0) {
    // A truncated stream cannot be decoded reliably (zstd, for one, returns
    // partial output without an error), so keep the raw bytes.
    if (truncated) return { text: bytesToBase64(body), encoding: 'base64' };
    try {
      decoded = decodeContentCodings(body, codings);
      decodedSize = decoded.byteLength;
    } catch {
      return { text: bytesToBase64(body), encoding: 'base64' };
    }
  }
  const sized = decodedSize === undefined ? {} : { decodedSize };
  if (isTextualContentType(contentType)) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded), ...sized };
    } catch {
      // Not valid UTF-8; fall through to base64.
    }
  }
  return { text: bytesToBase64(decoded), encoding: 'base64', ...sized };
}

// Guards against decompression bombs; larger bodies fall back to base64 of the raw bytes.
const MAX_DECODED_BODY_BYTES = 64 * 1024 * 1024;

function parseContentEncoding(contentEncoding: string | undefined): string[] {
  return (contentEncoding ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '' && coding !== 'identity');
}

/** Undoes codings in reverse of the order they were applied. Throws on unknown or corrupt input. */
function decodeContentCodings(body: Uint8Array, codings: string[]): Uint8Array {
  const options = { maxOutputLength: MAX_DECODED_BODY_BYTES };
  let data: Uint8Array = body;
  for (const coding of [...codings].reverse()) {
    switch (coding) {
      case 'gzip':
      case 'x-gzip':
        data = zlib.gunzipSync(data, options);
        break;
      case 'deflate':
        // Servers send both zlib-wrapped (per spec) and raw deflate streams.
        try {
          data = zlib.inflateSync(data, options);
        } catch {
          data = zlib.inflateRawSync(data, options);
        }
        break;
      case 'br':
        data = zlib.brotliDecompressSync(data, options);
        break;
      case 'zstd': {
        // Available from Node 22.15 / 23.8.
        const zstdDecompressSync = (zlib as any).zstdDecompressSync as
          | ((buffer: Uint8Array, options?: object) => Buffer)
          | undefined;
        if (!zstdDecompressSync) throw new Error('zstd decompression is not supported by this Node.js');
        data = zstdDecompressSync(data, options);
        break;
      }
      default:
        throw new Error(`Unsupported content encoding: ${coding}`);
    }
  }
  return data;
}

function isTextualContentType(contentType: string | undefined): boolean {
  const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    mimeType.startsWith('text/') ||
    mimeType.endsWith('+json') ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript' ||
    mimeType === 'application/x-www-form-urlencoded' ||
    mimeType === 'application/graphql'
  );
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    result += second === undefined ? '=' : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    result += third === undefined ? '=' : alphabet[third & 63];
  }
  return result;
}
