import type { Entry as HAREntry, Request as HARRequest, Response as HARResponse } from 'har-format';
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
  const { request, encoding: requestBodyEncoding } = addRequestBody(complete.request, requestBody);
  const response = addResponseBody(complete.response, responseBody);
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
      requestBodyTruncated: complete._limrun.requestBodyTruncated === true || capture.requestTruncated,
      responseBodyTruncated: complete._limrun.responseBodyTruncated === true || capture.responseTruncated,
    },
  };
}

function addRequestBody(request: HARRequest, body: Uint8Array): { request: HARRequest; encoding?: 'base64' } {
  if (body.byteLength === 0) return { request };
  const mimeType = request.postData?.mimeType ?? headerValue(request.headers, 'content-type');
  const encoded = encodedBody(body, mimeType);
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

function addResponseBody(response: HARResponse, body: Uint8Array): HARResponse {
  if (body.byteLength === 0) return response;
  const content = { ...response.content };
  delete content.text;
  delete content.encoding;
  return {
    ...response,
    content: {
      ...content,
      ...encodedBody(body, response.content.mimeType),
    },
  };
}

function encodedBody(
  body: Uint8Array,
  contentType: string | undefined,
): { text: string; encoding?: 'base64' } {
  if (isTextualContentType(contentType)) {
    return { text: new TextDecoder().decode(body) };
  }
  return { text: bytesToBase64(body), encoding: 'base64' };
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
