import { WebSocket, type RawData } from 'ws';
import type {
  Cache,
  CacheDetails,
  Content,
  Cookie,
  Entry,
  Header,
  Param,
  PostData,
  QueryString,
  Request,
  Response,
  Timings,
} from 'har-format';
import { nodeProxyTransport } from './internal/proxy-transport';
import { DestinationTunnelProtocolError } from './destination-tunnel';

export const DESTINATION_TUNNEL_INSPECTION_BINARY_VERSION = 1;

export interface DestinationTunnelInspectionExtension {
  requestId: string;
  tunnelId: string;
  selectorId: string;
  protocol: string;
  tls: boolean;
  grpc?: boolean;
  webSocket?: boolean;
  error?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  responseTrailers?: Header[];
  responseCookieSameSite?: Array<{ index: number; value: string }>;
}

export type DestinationTunnelInspectionComplete = Entry & {
  _limrun: DestinationTunnelInspectionExtension;
};

export type DestinationTunnelInspectionMetadataEvent =
  | {
      type: 'request';
      sequence: number;
      requestId: string;
      data: Request;
    }
  | {
      type: 'response';
      sequence: number;
      requestId: string;
      data: Response;
    }
  | {
      type: 'complete';
      sequence: number;
      requestId: string;
      data: DestinationTunnelInspectionComplete;
    }
  | {
      type: 'gap';
      sequence: number;
      data: { fromSequence: number; toSequence: number };
    }
  | {
      type: 'inspection_error';
      sequence: number;
      requestId?: string;
      data: { message: string; [key: string]: unknown };
    };

export interface DestinationTunnelInspectionBodyEvent {
  type: 'body';
  sequence: number;
  requestId: string;
  direction: 'request' | 'response';
  body: Buffer;
}

export type DestinationTunnelInspectionEvent =
  | DestinationTunnelInspectionMetadataEvent
  | DestinationTunnelInspectionBodyEvent;

export interface DestinationTunnelInspectionGap {
  fromSequence: number;
  toSequence: number;
  message: string;
}

export type DestinationTunnelInspectionEventCallback = (event: DestinationTunnelInspectionEvent) => void;
export type DestinationTunnelInspectionGapCallback = (gap: DestinationTunnelInspectionGap) => void;
export type DestinationTunnelInspectionErrorCallback = (error: Error) => void;

export interface DestinationTunnelInspectionStreamOptions {
  onEvent?: DestinationTunnelInspectionEventCallback;
  onGap?: DestinationTunnelInspectionGapCallback;
  onError?: DestinationTunnelInspectionErrorCallback;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface DestinationTunnelInspectionStream {
  close: () => void;
  getLastSequence: () => number;
}

/**
 * Follow one tunnel's inspection feed independently from its data WebSocket.
 * Transport and protocol failures are reported to callbacks and retried until
 * the owner closes this handle.
 */
export function startDestinationTunnelInspectionStream(
  remoteURL: string,
  tunnelId: string,
  token: string,
  options: DestinationTunnelInspectionStreamOptions = {},
): DestinationTunnelInspectionStream {
  const initialDelay = positiveInteger(options.reconnectInitialDelayMs ?? 250, 'reconnectInitialDelayMs');
  const maxDelay = positiveInteger(options.reconnectMaxDelayMs ?? 5_000, 'reconnectMaxDelayMs');
  if (initialDelay > maxDelay) {
    throw new Error('reconnectInitialDelayMs must not exceed reconnectMaxDelayMs');
  }

  let active = true;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;
  let lastSequence = 0;
  let receivedOnConnection = false;

  const reportError = (error: Error): void => {
    invokeSafely(options.onError, error);
  };

  const emitGap = (fromSequence: number, toSequence: number): void => {
    const gap = {
      fromSequence,
      toSequence,
      message: `Inspection stream gap: missing sequences ${fromSequence}-${toSequence}`,
    };
    invokeSafely(options.onGap, gap, reportError);
    invokeSafely(
      options.onEvent,
      { type: 'gap', sequence: toSequence, data: { fromSequence, toSequence } },
      reportError,
    );
  };

  const acceptSequence = (
    sequence: number,
    explicitGap?: { fromSequence: number; toSequence: number },
  ): void => {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new DestinationTunnelProtocolError('inspection sequence must be a safe non-negative integer');
    }
    if (sequence <= lastSequence) {
      throw new DestinationTunnelProtocolError(
        `inspection sequence ${sequence} is not newer than ${lastSequence}`,
      );
    }
    if (explicitGap) {
      if (
        explicitGap.fromSequence !== lastSequence + 1 ||
        explicitGap.toSequence !== sequence ||
        explicitGap.fromSequence > explicitGap.toSequence
      ) {
        throw new DestinationTunnelProtocolError('invalid inspection gap range');
      }
      emitGap(explicitGap.fromSequence, explicitGap.toSequence);
    } else if (sequence > lastSequence + 1) {
      emitGap(lastSequence + 1, sequence - 1);
    }
    lastSequence = sequence;
    if (!receivedOnConnection) {
      receivedOnConnection = true;
      reconnectAttempt = 0;
    }
  };

  const scheduleReconnect = (): void => {
    if (!active || reconnectTimer) return;
    const delay = Math.min(initialDelay * 2 ** reconnectAttempt, maxDelay);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 30);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref();
  };

  const failProtocol = (error: unknown): void => {
    reportError(error instanceof Error ? error : new Error(String(error)));
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close(1002, 'invalid inspection frame');
    }
  };

  const connect = (): void => {
    if (!active) return;
    const url = deriveDestinationTunnelInspectionURL(remoteURL, tunnelId, lastSequence);
    const agent = nodeProxyTransport.getWebSocketAgent(url);
    const current = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      ...(agent ? { agent } : {}),
      perMessageDeflate: false,
    });
    socket = current;
    receivedOnConnection = false;

    current.on('message', (data: RawData, isBinary: boolean) => {
      if (!active || socket !== current) return;
      try {
        const event =
          isBinary ?
            decodeDestinationTunnelInspectionBodyFrame(toBuffer(data))
          : decodeDestinationTunnelInspectionMetadataFrame(toBuffer(data).toString('utf8'));
        if (event.type === 'gap') {
          acceptSequence(event.sequence, event.data);
        } else {
          acceptSequence(event.sequence);
          invokeSafely(options.onEvent, event, reportError);
        }
      } catch (error) {
        failProtocol(error);
      }
    });
    current.once('error', (error: Error) => {
      if (!active || socket !== current) return;
      reportError(error);
    });
    current.once('close', () => {
      current.removeAllListeners();
      if (socket === current) socket = undefined;
      scheduleReconnect();
    });
  };

  const close = (): void => {
    if (!active) return;
    active = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const current = socket;
    socket = undefined;
    current?.removeAllListeners();
    // Closing a WebSocket while its handshake is still in flight can emit an
    // asynchronous error. Keep it handled after detaching the stream callbacks.
    current?.on('error', () => {});
    if (current?.readyState === WebSocket.OPEN || current?.readyState === WebSocket.CONNECTING) {
      current.close(1000, 'tunnel closed');
    }
  };

  connect();
  return { close, getLastSequence: () => lastSequence };
}

export function deriveDestinationTunnelInspectionURL(
  remoteURL: string,
  tunnelId: string,
  afterSequence = 0,
): string {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('afterSequence must be a safe non-negative integer');
  }
  const url = new URL(remoteURL);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(tunnelId)}/inspection`;
  url.search = '';
  url.searchParams.set('after-sequence', String(afterSequence));
  url.hash = '';
  return url.toString();
}

export function decodeDestinationTunnelInspectionBodyFrame(
  frame: Buffer,
): DestinationTunnelInspectionBodyEvent {
  if (frame.length < 12 || frame[0] !== DESTINATION_TUNNEL_INSPECTION_BINARY_VERSION) {
    throw new DestinationTunnelProtocolError('invalid inspection body frame');
  }
  const rawSequence = frame.readBigUInt64BE(1);
  if (rawSequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DestinationTunnelProtocolError(
      'inspection binary sequence exceeds JavaScript safe integer range',
    );
  }
  const requestIdLength = frame.readUInt16BE(9);
  if (frame.length < 12 + requestIdLength) {
    throw new DestinationTunnelProtocolError('truncated inspection body frame');
  }
  const kind = frame[11];
  if (kind !== 1 && kind !== 2) {
    throw new DestinationTunnelProtocolError('invalid inspection body kind');
  }
  const requestIdBytes = frame.subarray(12, 12 + requestIdLength);
  const requestId = decodeUtf8(requestIdBytes, 'inspection request ID');
  if (!requestId) {
    throw new DestinationTunnelProtocolError('inspection body request ID must not be empty');
  }
  return {
    type: 'body',
    sequence: Number(rawSequence),
    requestId,
    direction: kind === 1 ? 'request' : 'response',
    body: Buffer.from(frame.subarray(12 + requestIdLength)),
  };
}

export function decodeDestinationTunnelInspectionMetadataFrame(
  text: string,
): DestinationTunnelInspectionMetadataEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DestinationTunnelProtocolError('inspection metadata frame must be valid JSON');
  }
  const record = readRecord(parsed, 'inspection metadata');
  const sequence = readSafeSequence(record['sequence']);
  const type = readString(record, 'type');
  const data = readRecord(record['data'], 'inspection metadata data');
  switch (type) {
    case 'request':
      return {
        type,
        sequence,
        requestId: readRequiredRequestId(record),
        data: readRequest(data),
      };
    case 'response':
      return {
        type,
        sequence,
        requestId: readRequiredRequestId(record),
        data: readResponse(data),
      };
    case 'complete': {
      const requestId = readRequiredRequestId(record);
      return { type, sequence, requestId, data: readComplete(data, requestId) };
    }
    case 'gap': {
      const fromSequence = readSafeSequence(data['fromSequence']);
      const toSequence = readSafeSequence(data['toSequence']);
      return { type, sequence, data: { fromSequence, toSequence } };
    }
    case 'inspection_error':
      return {
        type,
        sequence,
        ...(record['requestId'] === undefined ? {} : { requestId: readString(record, 'requestId') }),
        data: { ...data, message: readString(data, 'message') },
      };
    default:
      throw new DestinationTunnelProtocolError(`unknown inspection metadata type ${type}`);
  }
}

function readComplete(
  record: Record<string, unknown>,
  envelopeRequestId: string,
): DestinationTunnelInspectionComplete {
  const extension = readExtension(readRecord(record['_limrun'], 'inspection extension'));
  if (extension.requestId !== envelopeRequestId) {
    throw new DestinationTunnelProtocolError('inspection complete request ID does not match its envelope');
  }
  return {
    startedDateTime: readDateTime(record, 'startedDateTime'),
    time: readFiniteNumber(record, 'time'),
    request: readRequest(readRecord(record['request'], 'inspection request')),
    response: readResponse(readRecord(record['response'], 'inspection response')),
    cache: readCache(readRecord(record['cache'], 'inspection cache')),
    timings: readTimings(readRecord(record['timings'], 'inspection timings')),
    ...readOptionalString(record, 'pageref'),
    ...readOptionalString(record, 'serverIPAddress'),
    ...readOptionalString(record, 'connection'),
    ...readOptionalString(record, 'comment'),
    _limrun: extension,
  };
}

function readExtension(record: Record<string, unknown>): DestinationTunnelInspectionExtension {
  return {
    requestId: readString(record, 'requestId'),
    tunnelId: readString(record, 'tunnelId'),
    selectorId: readString(record, 'selectorId'),
    protocol: readString(record, 'protocol'),
    tls: readBoolean(record, 'tls'),
    ...readOptionalBoolean(record, 'grpc'),
    ...readOptionalBoolean(record, 'webSocket'),
    ...readOptionalString(record, 'error'),
    ...readOptionalBoolean(record, 'requestBodyTruncated'),
    ...readOptionalBoolean(record, 'responseBodyTruncated'),
    ...(record['responseTrailers'] === undefined ?
      {}
    : { responseTrailers: readHeaders(record['responseTrailers'], 'response trailers') }),
    ...(record['responseCookieSameSite'] === undefined ?
      {}
    : { responseCookieSameSite: readResponseCookieSameSite(record['responseCookieSameSite']) }),
  };
}

function readRequest(record: Record<string, unknown>): Request {
  return {
    method: readString(record, 'method'),
    url: readString(record, 'url'),
    httpVersion: readString(record, 'httpVersion'),
    headers: readHeaders(record['headers'], 'request headers'),
    queryString: readQueryStrings(record['queryString']),
    cookies: readCookies(record['cookies']),
    headersSize: readFiniteNumber(record, 'headersSize'),
    bodySize: readFiniteNumber(record, 'bodySize'),
    ...(record['postData'] === undefined ?
      {}
    : { postData: readPostData(readRecord(record['postData'], 'request post data')) }),
    ...readOptionalString(record, 'comment'),
  };
}

function readResponse(record: Record<string, unknown>): Response {
  return {
    status: readFiniteNumber(record, 'status'),
    statusText: readString(record, 'statusText'),
    httpVersion: readString(record, 'httpVersion'),
    headers: readHeaders(record['headers'], 'response headers'),
    cookies: readCookies(record['cookies']),
    content: readContent(readRecord(record['content'], 'response content')),
    redirectURL: readString(record, 'redirectURL'),
    headersSize: readFiniteNumber(record, 'headersSize'),
    bodySize: readFiniteNumber(record, 'bodySize'),
    ...readOptionalString(record, 'comment'),
  };
}

function readPostData(record: Record<string, unknown>): PostData {
  const hasParams = record['params'] !== undefined;
  const hasText = record['text'] !== undefined;
  if (hasParams === hasText) {
    throw new DestinationTunnelProtocolError('request post data must contain exactly one of params or text');
  }
  const common = {
    mimeType: readString(record, 'mimeType'),
    ...readOptionalString(record, 'comment'),
  };
  return hasParams ?
      { ...common, params: readParams(record['params']) }
    : { ...common, text: readString(record, 'text') };
}

function readContent(record: Record<string, unknown>): Content {
  return {
    size: readFiniteNumber(record, 'size'),
    mimeType: readString(record, 'mimeType'),
    ...readOptionalFiniteNumber(record, 'compression'),
    ...readOptionalString(record, 'text'),
    ...readOptionalString(record, 'encoding'),
    ...readOptionalString(record, 'comment'),
  };
}

function readCache(record: Record<string, unknown>): Cache {
  return {
    ...(record['beforeRequest'] === undefined ?
      {}
    : { beforeRequest: readCacheDetailsOrNull(record['beforeRequest'], 'cache beforeRequest') }),
    ...(record['afterRequest'] === undefined ?
      {}
    : { afterRequest: readCacheDetailsOrNull(record['afterRequest'], 'cache afterRequest') }),
    ...readOptionalString(record, 'comment'),
  };
}

function readCacheDetailsOrNull(value: unknown, name: string): CacheDetails | null {
  if (value === null) return null;
  const record = readRecord(value, name);
  return {
    lastAccess: readDateTime(record, 'lastAccess'),
    eTag: readString(record, 'eTag'),
    hitCount: readFiniteNumber(record, 'hitCount'),
    ...readOptionalDateTime(record, 'expires'),
    ...readOptionalString(record, 'comment'),
  };
}

function readTimings(record: Record<string, unknown>): Timings {
  return {
    blocked: readFiniteNumber(record, 'blocked'),
    dns: readFiniteNumber(record, 'dns'),
    connect: readFiniteNumber(record, 'connect'),
    ssl: readFiniteNumber(record, 'ssl'),
    send: readFiniteNumber(record, 'send'),
    wait: readFiniteNumber(record, 'wait'),
    receive: readFiniteNumber(record, 'receive'),
    ...readOptionalString(record, 'comment'),
  };
}

function readHeaders(value: unknown, name: string): Header[] {
  // Go's nil slices encode as null on failures that occur before response
  // headers exist. Normalize those valid zero values to empty HAR arrays.
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an array`);
  }
  return value.map((item) => {
    const record = readRecord(item, name);
    return {
      name: readString(record, 'name'),
      value: readString(record, 'value'),
      ...readOptionalString(record, 'comment'),
    };
  });
}

function readQueryStrings(value: unknown): QueryString[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError('request query string must be an array');
  }
  return value.map((item) => {
    const record = readRecord(item, 'request query string');
    return {
      name: readString(record, 'name'),
      value: readString(record, 'value'),
      ...readOptionalString(record, 'comment'),
    };
  });
}

function readParams(value: unknown): Param[] {
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError('post data params must be an array');
  }
  return value.map((item) => {
    const record = readRecord(item, 'post data param');
    return {
      name: readString(record, 'name'),
      ...readOptionalString(record, 'value'),
      ...readOptionalString(record, 'fileName'),
      ...readOptionalString(record, 'contentType'),
      ...readOptionalString(record, 'comment'),
    };
  });
}

function readCookies(value: unknown): Cookie[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError('inspection cookies must be an array');
  }
  return value.map((item) => {
    const record = readRecord(item, 'inspection cookie');
    return {
      name: readString(record, 'name'),
      value: readString(record, 'value'),
      ...readOptionalString(record, 'path'),
      ...readOptionalString(record, 'domain'),
      ...readOptionalDateTime(record, 'expires'),
      ...readOptionalBoolean(record, 'httpOnly'),
      ...readOptionalBoolean(record, 'secure'),
      ...readOptionalString(record, 'comment'),
    };
  });
}

function readResponseCookieSameSite(value: unknown): Array<{ index: number; value: string }> {
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError('response cookie same-site metadata must be an array');
  }
  return value.map((item) => {
    const record = readRecord(item, 'response cookie same-site metadata');
    const index = record['index'];
    if (!Number.isSafeInteger(index) || (index as number) < 0) {
      throw new DestinationTunnelProtocolError(
        'response cookie same-site index must be a safe non-negative integer',
      );
    }
    return { index: index as number, value: readString(record, 'value') };
  });
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredRequestId(record: Record<string, unknown>): string {
  const requestId = readString(record, 'requestId');
  if (!requestId) throw new DestinationTunnelProtocolError('inspection request ID must not be empty');
  return requestId;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError(`${key} must be a string`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new DestinationTunnelProtocolError(`${key} must be a boolean`);
  }
  return value;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be a finite number`);
  }
  return value;
}

function readSafeSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DestinationTunnelProtocolError('inspection sequence must be a safe non-negative integer');
  }
  return value as number;
}

function readDateTime(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new DestinationTunnelProtocolError(`${key} must be an ISO date-time`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  return record[key] === undefined ? {} : { [key]: readString(record, key) };
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): { [K in typeof key]?: boolean } {
  return record[key] === undefined ? {} : { [key]: readBoolean(record, key) };
}

function readOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): { [K in typeof key]?: number } {
  return record[key] === undefined ? {} : { [key]: readFiniteNumber(record, key) };
}

function readOptionalDateTime(record: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  return record[key] === undefined ? {} : { [key]: readDateTime(record, key) };
}

function decodeUtf8(value: Buffer, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new DestinationTunnelProtocolError(`${name} must be valid UTF-8`);
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new DestinationTunnelProtocolError('unsupported WebSocket payload type');
}

function invokeSafely<T>(
  callback: ((value: T) => void) | undefined,
  value: T,
  onFailure?: (error: Error) => void,
): void {
  if (!callback) return;
  try {
    callback(value);
  } catch (error) {
    onFailure?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
