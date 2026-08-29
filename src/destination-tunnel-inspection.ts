import { WebSocket, type RawData } from 'ws';
import type {
  Cache as HARCache,
  Content as HARContent,
  Cookie as HARCookie,
  Entry as HAREntry,
  Header as HARHeader,
  Request as HARRequest,
  Response as HARResponse,
  Timings as HARTimings,
} from 'har-format';
import { nodeProxyTransport } from './internal/proxy-transport';
import { DestinationTunnelProtocolError } from './destination-tunnel';

export const DESTINATION_TUNNEL_INSPECTION_BINARY_VERSION = 1;

export type DestinationTunnelInspectionNameValue = HARHeader;

export interface DestinationTunnelInspectionCookie extends HARCookie {
  sameSite?: string;
}

export interface DestinationTunnelInspectionPostData {
  mimeType?: string;
  params?: DestinationTunnelInspectionNameValue[];
}

export interface DestinationTunnelInspectionContent extends Omit<HARContent, 'mimeType'> {
  mimeType?: string;
}

export interface DestinationTunnelInspectionRequest
  extends Omit<HARRequest, 'headers' | 'queryString' | 'cookies' | 'postData'> {
  headers: DestinationTunnelInspectionNameValue[];
  queryString: DestinationTunnelInspectionNameValue[];
  cookies: DestinationTunnelInspectionCookie[];
  postData?: DestinationTunnelInspectionPostData;
}

export interface DestinationTunnelInspectionResponse
  extends Omit<HARResponse, 'headers' | 'cookies' | 'content'> {
  headers: DestinationTunnelInspectionNameValue[];
  cookies: DestinationTunnelInspectionCookie[];
  content: DestinationTunnelInspectionContent;
  trailers?: DestinationTunnelInspectionNameValue[];
}

export type DestinationTunnelInspectionTimings = Required<
  Pick<HARTimings, 'blocked' | 'dns' | 'connect' | 'ssl' | 'send' | 'wait' | 'receive'>
>;

export interface DestinationTunnelInspectionComplete
  extends Omit<HAREntry, 'request' | 'response' | 'cache' | 'timings'> {
  requestId: string;
  tunnelId: string;
  selectorId: string;
  request: DestinationTunnelInspectionRequest;
  response: DestinationTunnelInspectionResponse;
  cache: HARCache;
  timings: DestinationTunnelInspectionTimings;
  protocol: string;
  tls: boolean;
  grpc?: boolean;
  webSocket?: boolean;
  error?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
}

export type DestinationTunnelInspectionMetadataEvent =
  | {
      type: 'request';
      sequence: number;
      requestId: string;
      data: DestinationTunnelInspectionRequest;
    }
  | {
      type: 'response';
      sequence: number;
      requestId: string;
      data: DestinationTunnelInspectionResponse;
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
  const requestId = readString(record, 'requestId');
  if (requestId !== envelopeRequestId) {
    throw new DestinationTunnelProtocolError('inspection complete request ID does not match its envelope');
  }
  return {
    requestId,
    tunnelId: readString(record, 'tunnelId'),
    selectorId: readString(record, 'selectorId'),
    startedDateTime: readDateTime(record, 'startedDateTime'),
    time: readFiniteNumber(record, 'time'),
    request: readRequest(readRecord(record['request'], 'inspection request')),
    response: readResponse(readRecord(record['response'], 'inspection response')),
    cache: readRecord(record['cache'], 'inspection cache') as HARCache,
    timings: readTimings(readRecord(record['timings'], 'inspection timings')),
    protocol: readString(record, 'protocol'),
    tls: readBoolean(record, 'tls'),
    ...readOptionalString(record, 'serverIPAddress'),
    ...readOptionalString(record, 'connection'),
    ...readOptionalBoolean(record, 'grpc'),
    ...readOptionalBoolean(record, 'webSocket'),
    ...readOptionalString(record, 'error'),
    ...readOptionalBoolean(record, 'requestBodyTruncated'),
    ...readOptionalBoolean(record, 'responseBodyTruncated'),
  };
}

function readRequest(record: Record<string, unknown>): DestinationTunnelInspectionRequest {
  return {
    method: readString(record, 'method'),
    url: readString(record, 'url'),
    httpVersion: readString(record, 'httpVersion'),
    headers: readNameValues(record['headers'], 'request headers'),
    queryString: readNameValues(record['queryString'], 'request query string'),
    cookies: readCookies(record['cookies']),
    headersSize: readFiniteNumber(record, 'headersSize'),
    bodySize: readFiniteNumber(record, 'bodySize'),
    ...(record['postData'] === undefined ?
      {}
    : { postData: readPostData(readRecord(record['postData'], 'request post data')) }),
  };
}

function readResponse(record: Record<string, unknown>): DestinationTunnelInspectionResponse {
  return {
    status: readFiniteNumber(record, 'status'),
    statusText: readString(record, 'statusText'),
    httpVersion: readString(record, 'httpVersion'),
    headers: readNameValues(record['headers'], 'response headers'),
    cookies: readCookies(record['cookies']),
    content: readContent(readRecord(record['content'], 'response content')),
    redirectURL: readString(record, 'redirectURL'),
    headersSize: readFiniteNumber(record, 'headersSize'),
    bodySize: readFiniteNumber(record, 'bodySize'),
    ...(record['trailers'] === undefined ?
      {}
    : { trailers: readNameValues(record['trailers'], 'response trailers') }),
  };
}

function readPostData(record: Record<string, unknown>): DestinationTunnelInspectionPostData {
  return {
    ...readOptionalString(record, 'mimeType'),
    ...(record['params'] === undefined ?
      {}
    : { params: readNameValues(record['params'], 'post data params') }),
  };
}

function readContent(record: Record<string, unknown>): DestinationTunnelInspectionContent {
  return {
    size: readFiniteNumber(record, 'size'),
    ...readOptionalString(record, 'mimeType'),
    ...readOptionalString(record, 'text'),
    ...readOptionalString(record, 'encoding'),
  };
}

function readTimings(record: Record<string, unknown>): DestinationTunnelInspectionTimings {
  return {
    blocked: readFiniteNumber(record, 'blocked'),
    dns: readFiniteNumber(record, 'dns'),
    connect: readFiniteNumber(record, 'connect'),
    ssl: readFiniteNumber(record, 'ssl'),
    send: readFiniteNumber(record, 'send'),
    wait: readFiniteNumber(record, 'wait'),
    receive: readFiniteNumber(record, 'receive'),
  };
}

function readNameValues(value: unknown, name: string): DestinationTunnelInspectionNameValue[] {
  // Go's nil slices encode as null on failures that occur before response
  // headers exist. Normalize those valid zero values to empty HAR arrays.
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an array`);
  }
  return value.map((item) => {
    const record = readRecord(item, name);
    return { name: readString(record, 'name'), value: readString(record, 'value') };
  });
}

function readCookies(value: unknown): DestinationTunnelInspectionCookie[] {
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
      ...readOptionalString(record, 'expires'),
      ...readOptionalBoolean(record, 'httpOnly'),
      ...readOptionalBoolean(record, 'secure'),
      ...readOptionalString(record, 'sameSite'),
    };
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
