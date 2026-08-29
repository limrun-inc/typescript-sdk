import { createEventSource, type EventSourceClient } from 'eventsource-client';
import type { Entry, Header } from 'har-format';
import { nodeProxyTransport } from './internal/proxy-transport';
import { deriveDestinationTunnelInspectionURL } from './internal/destination-tunnel-url';
import {
  DestinationTunnelProtocolError,
  readArray,
  readFiniteNumber,
  readOptionalBoolean,
  readOptionalString,
  readRecord,
  readSafeNonNegativeInteger,
  readString,
} from './internal/destination-tunnel-wire-reader';

export { deriveDestinationTunnelInspectionURL } from './internal/destination-tunnel-url';

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
  body: Uint8Array;
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
 * Follow one tunnel's inspection SSE feed independently from its data
 * WebSocket. Authentication is carried in `?token=` so the same endpoint can
 * be consumed by browser-native EventSource.
 */
export function startDestinationTunnelInspectionStream(
  remoteURL: string,
  tunnelId: string,
  token: string,
  options: DestinationTunnelInspectionStreamOptions = {},
): DestinationTunnelInspectionStream {
  let active = true;
  let lastSequence = 0;

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
  };

  const url = deriveDestinationTunnelInspectionURL(remoteURL, tunnelId, lastSequence, token);
  const source: EventSourceClient = createEventSource({
    url,
    fetch: nodeProxyTransport.fetch.bind(nodeProxyTransport),
    onMessage: (message) => {
      if (!active) return;
      try {
        const event = decodeDestinationTunnelInspectionSSEEvent(message.id, message.data);
        if (event.type === 'gap') {
          acceptSequence(event.sequence, event.data);
        } else {
          acceptSequence(event.sequence);
          invokeSafely(options.onEvent, event, reportError);
        }
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onDisconnect: () => {
      if (active) reportError(new Error('Inspection SSE disconnected; reconnecting'));
    },
  });

  const close = (): void => {
    if (!active) return;
    active = false;
    source.close();
  };

  return { close };
}

/**
 * Decode one browser/EventSource message while keeping the public inspection
 * event API independent of SSE transport details.
 */
export function decodeDestinationTunnelInspectionSSEEvent(
  lastEventId: string | undefined,
  text: string,
): DestinationTunnelInspectionEvent {
  if (lastEventId === undefined || !/^(0|[1-9]\d*)$/.test(lastEventId)) {
    throw new DestinationTunnelProtocolError('inspection SSE event ID must be an unsigned integer');
  }
  const sequence = Number(lastEventId);
  if (!Number.isSafeInteger(sequence)) {
    throw new DestinationTunnelProtocolError('inspection sequence must be a safe non-negative integer');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DestinationTunnelProtocolError('inspection SSE data must be valid JSON');
  }
  const record = readRecord(parsed, 'inspection event');
  if (record['sequence'] !== undefined) {
    const envelopeSequence = readSafeNonNegativeInteger(record['sequence'], 'inspection sequence');
    if (envelopeSequence !== sequence) {
      throw new DestinationTunnelProtocolError('inspection SSE event ID does not match envelope sequence');
    }
  }
  if (readString(record, 'type') !== 'body') {
    return decodeDestinationTunnelInspectionMetadataRecord(record, sequence);
  }
  const requestId = readRequiredRequestId(record);
  const data = readRecord(record['data'], 'inspection body data');
  const direction = readString(data, 'direction');
  if (direction !== 'request' && direction !== 'response') {
    throw new DestinationTunnelProtocolError('invalid inspection body direction');
  }
  if (readString(data, 'encoding') !== 'base64') {
    throw new DestinationTunnelProtocolError('inspection body encoding must be base64');
  }
  const body = decodeCanonicalBase64(readString(data, 'chunk'));
  return {
    type: 'body',
    sequence,
    requestId,
    direction,
    body,
  };
}

function decodeDestinationTunnelInspectionMetadataRecord(
  record: Record<string, unknown>,
  sequence: number,
): DestinationTunnelInspectionMetadataEvent {
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

function decodeCanonicalBase64(value: string): Uint8Array {
  try {
    if (value.length % 4 !== 0) throw new Error('invalid base64 length');
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error('non-canonical base64');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new DestinationTunnelProtocolError('inspection body chunk must be valid base64');
  }
}
