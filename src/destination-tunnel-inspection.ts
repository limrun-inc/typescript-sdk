import { WebSocket, type RawData } from 'ws';
import type { Entry, Header } from 'har-format';
import { nodeProxyTransport } from './internal/proxy-transport';
import { deriveDestinationTunnelInspectionURL } from './internal/destination-tunnel-url';
import {
  DestinationTunnelProtocolError,
  decodeUtf8,
  readArray,
  readFiniteNumber,
  readOptionalBoolean,
  readOptionalString,
  readRecord,
  readSafeNonNegativeInteger,
  readString,
  toBuffer,
} from './internal/destination-tunnel-wire-reader';

export { deriveDestinationTunnelInspectionURL } from './internal/destination-tunnel-url';

export const DESTINATION_TUNNEL_INSPECTION_BINARY_VERSION = 1;

export interface DestinationTunnelInspectionExtension {
  tunnelId: string;
  selectorId: string;
  error?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  responseTrailers?: Header[];
  responseCookieSameSite?: Array<{ index: number; value: string }>;
}

export type DestinationTunnelInspectionComplete = Entry & {
  _limrun: DestinationTunnelInspectionExtension;
};

export interface DestinationTunnelInspectionGap {
  fromSequence: number;
  toSequence: number;
  message: string;
}

export type DestinationTunnelInspectionMetadataEvent =
  | {
      type: 'complete';
      sequence: number;
      requestId: string;
      data: DestinationTunnelInspectionComplete;
    }
  | {
      type: 'gap';
      sequence: number;
      data: DestinationTunnelInspectionGap;
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

export type DestinationTunnelInspectionEventCallback = (event: DestinationTunnelInspectionEvent) => void;
export type DestinationTunnelInspectionErrorCallback = (error: Error) => void;

export interface DestinationTunnelInspectionStreamOptions {
  onEvent?: DestinationTunnelInspectionEventCallback;
  onError?: DestinationTunnelInspectionErrorCallback;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface DestinationTunnelInspectionStream {
  close: () => void;
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
    invokeSafely(
      options.onEvent,
      {
        type: 'gap',
        sequence: toSequence,
        data: {
          fromSequence,
          toSequence,
          message: `Inspection stream gap: missing sequences ${fromSequence}-${toSequence}`,
        },
      },
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
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    current?.removeAllListeners();
    current?.on('error', () => {});
    if (current?.readyState === WebSocket.OPEN || current?.readyState === WebSocket.CONNECTING) {
      current.close(1000, 'tunnel closed');
    }
  };

  connect();
  return { close };
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
  const requestId = decodeUtf8(frame.subarray(12, 12 + requestIdLength), 'inspection request ID');
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
  const sequence = readSafeNonNegativeInteger(record['sequence'], 'inspection sequence');
  const type = readString(record, 'type');
  const data = readRecord(record['data'], 'inspection metadata data');
  switch (type) {
    case 'complete':
      return {
        type,
        sequence,
        requestId: readRequiredRequestId(record),
        data: readComplete(data),
      };
    case 'gap': {
      const fromSequence = readSafeNonNegativeInteger(data['fromSequence'], 'inspection sequence');
      const toSequence = readSafeNonNegativeInteger(data['toSequence'], 'inspection sequence');
      return {
        type,
        sequence,
        data: {
          fromSequence,
          toSequence,
          message: `Inspection stream gap: missing sequences ${fromSequence}-${toSequence}`,
        },
      };
    }
    case 'inspection_error':
      return {
        type,
        sequence,
        ...(record['requestId'] === undefined ? {} : { requestId: readRequiredRequestId(record) }),
        data: { ...data, message: readString(data, 'message') },
      };
    default:
      throw new DestinationTunnelProtocolError(`unknown inspection metadata type ${type}`);
  }
}

function readComplete(record: Record<string, unknown>): DestinationTunnelInspectionComplete {
  readDateTime(record, 'startedDateTime');
  readFiniteNumber(record, 'time');
  readRequest(readRecord(record['request'], 'inspection request'));
  readResponse(readRecord(record['response'], 'inspection response'));
  readExtension(readRecord(record['_limrun'], 'inspection extension'));
  return record as unknown as DestinationTunnelInspectionComplete;
}

function readExtension(record: Record<string, unknown>): void {
  readString(record, 'tunnelId');
  readString(record, 'selectorId');
  readOptionalString(record, 'error');
  readOptionalBoolean(record, 'requestBodyTruncated');
  readOptionalBoolean(record, 'responseBodyTruncated');
  if (record['responseTrailers'] !== undefined) {
    readNameValueArray(record['responseTrailers'], 'response trailers');
  }
  if (record['responseCookieSameSite'] !== undefined) {
    for (const item of readArray(record, 'responseCookieSameSite')) {
      const sameSite = readRecord(item, 'response cookie same-site metadata');
      readSafeNonNegativeInteger(sameSite['index'], 'response cookie same-site index');
      readString(sameSite, 'value');
    }
  }
}

function readRequest(record: Record<string, unknown>): void {
  readString(record, 'method');
  readString(record, 'url');
  readString(record, 'httpVersion');
  readNameValueArray(record['headers'], 'request headers');
  readNameValueArray(record['queryString'], 'request query string');
  readNameValueArray(record['cookies'], 'request cookies');
  readFiniteNumber(record, 'headersSize');
  readFiniteNumber(record, 'bodySize');
  if (record['postData'] !== undefined) {
    readRecord(record['postData'], 'request post data');
  }
}

function readResponse(record: Record<string, unknown>): void {
  readFiniteNumber(record, 'status');
  readString(record, 'statusText');
  readString(record, 'httpVersion');
  readNameValueArray(record['headers'], 'response headers');
  readNameValueArray(record['cookies'], 'response cookies');
  const content = readRecord(record['content'], 'response content');
  readFiniteNumber(content, 'size');
  readString(content, 'mimeType');
  readString(record, 'redirectURL');
  readFiniteNumber(record, 'headersSize');
  readFiniteNumber(record, 'bodySize');
}

function readNameValueArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an array`);
  }
  for (const item of value) {
    const record = readRecord(item, name);
    readString(record, 'name');
    readString(record, 'value');
  }
}

function readRequiredRequestId(record: Record<string, unknown>): string {
  const requestId = readString(record, 'requestId');
  if (!requestId) throw new DestinationTunnelProtocolError('inspection request ID must not be empty');
  return requestId;
}

function readDateTime(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new DestinationTunnelProtocolError(`${key} must be an ISO date-time`);
  }
  return value;
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
