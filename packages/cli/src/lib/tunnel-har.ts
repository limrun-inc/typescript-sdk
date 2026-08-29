import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type {
  Entry as HAREntry,
  Header as HARHeader,
  PostData as HARPostData,
  Request as HARRequest,
  Response as HARResponse,
} from 'har-format';
import {
  type DestinationTunnelInspectionComplete,
  type DestinationTunnelInspectionEvent,
  type DestinationTunnelInspectionGap,
  type DestinationTunnelInspectionRequest,
  type DestinationTunnelInspectionResponse,
} from '@limrun/api';

interface PendingCapture {
  requestBody: Buffer[];
  requestBytes: number;
  requestTruncated: boolean;
  responseBody: Buffer[];
  responseBytes: number;
  responseTruncated: boolean;
  gap: boolean;
}

type TunnelHarPostData = HARPostData & { _encoding?: string };
type TunnelHarRequest = Omit<HARRequest, 'postData'> & { postData?: TunnelHarPostData };
type TunnelHarResponse = HARResponse & { _trailers?: HARHeader[] };
interface TunnelHarEntry extends HAREntry {
  _limrun: Record<string, unknown>;
}

type SpoolRecord =
  | { type: 'entry'; entry: TunnelHarEntry }
  | { type: 'gap'; gap: DestinationTunnelInspectionGap };

export interface TunnelHarRecorder {
  onEvent: (event: DestinationTunnelInspectionEvent) => void;
  onGap: (gap: DestinationTunnelInspectionGap) => void;
  finalize: () => Promise<void>;
  close: () => void;
}

/**
 * Append-only NDJSON capture spool. Completed exchanges are durable
 * independently, while finalization streams them into HAR 1.2.
 */
export function createTunnelHarRecorder(harPath: string, bodyLimit: number): TunnelHarRecorder {
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1) {
    throw new Error('HAR body limit must be a positive integer');
  }
  const finalPath = path.resolve(harPath);
  const partialPath = `${finalPath}.partial`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  ensureAppendBoundary(partialPath);
  const descriptor = fs.openSync(partialPath, 'a', 0o600);
  fs.fchmodSync(descriptor, 0o600);
  const pending = new Map<string, PendingCapture>();
  let closed = false;

  const stateFor = (requestId: string): PendingCapture => {
    let state = pending.get(requestId);
    if (!state) {
      state = {
        requestBody: [],
        requestBytes: 0,
        requestTruncated: false,
        responseBody: [],
        responseBytes: 0,
        responseTruncated: false,
        gap: false,
      };
      pending.set(requestId, state);
    }
    return state;
  };

  const appendRecord = (record: SpoolRecord): void => {
    if (closed) return;
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
  };

  const onGap = (gap: DestinationTunnelInspectionGap): void => {
    for (const state of pending.values()) state.gap = true;
    appendRecord({ type: 'gap', gap });
  };

  const onEvent = (event: DestinationTunnelInspectionEvent): void => {
    if (closed || event.type === 'gap') return;
    if (event.type === 'body') {
      const state = stateFor(event.requestId);
      const response = event.direction === 'response';
      const bytes = response ? state.responseBytes : state.requestBytes;
      const take = Math.min(event.body.length, Math.max(0, bodyLimit - bytes));
      if (take > 0) {
        (response ? state.responseBody : state.requestBody).push(Buffer.from(event.body.subarray(0, take)));
      }
      if (response) {
        state.responseBytes += take;
        state.responseTruncated ||= take < event.body.length;
      } else {
        state.requestBytes += take;
        state.requestTruncated ||= take < event.body.length;
      }
      return;
    }
    if (event.type === 'request' || event.type === 'response') {
      stateFor(event.requestId);
      return;
    }
    if (event.type !== 'complete') return;

    const state = stateFor(event.requestId);
    try {
      appendRecord({
        type: 'entry',
        entry: makeHarEntry(event.data, state),
      });
    } finally {
      state.requestBody.length = 0;
      state.responseBody.length = 0;
      pending.delete(event.requestId);
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    pending.clear();
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  };

  const finalize = async (): Promise<void> => {
    close();
    const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    const output = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      fs.writeSync(
        output,
        '{"log":{"version":"1.2","creator":{"name":"Limrun CLI","version":"1"},"entries":[',
      );
      await copySpoolRecords(partialPath, 'entry', output);
      fs.writeSync(output, '],"_limrun":{"gaps":[');
      await copySpoolRecords(partialPath, 'gap', output);
      fs.writeSync(output, ']}}}\n');
      fs.fsyncSync(output);
    } catch (error) {
      fs.closeSync(output);
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    fs.closeSync(output);
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, finalPath);
    fs.rmSync(partialPath, { force: true });
  };

  return { onEvent, onGap, finalize, close };
}

export function formatInspectionSummary(event: DestinationTunnelInspectionComplete): string {
  const outcome = event.error ? `ERROR ${event.error}` : String(event.response.status);
  return `${event.request.method} ${event.request.url} ${outcome} ${event.time}ms ${event.response.bodySize} B`;
}

function makeHarEntry(
  complete: DestinationTunnelInspectionComplete,
  capture: PendingCapture,
): TunnelHarEntry {
  const requestBody = Buffer.concat(capture.requestBody, capture.requestBytes);
  const responseBody = Buffer.concat(capture.responseBody, capture.responseBytes);
  const request = addRequestBody(complete.request, requestBody);
  const response = addResponseBody(complete.response, responseBody);
  const requestTruncated = complete.requestBodyTruncated === true || capture.requestTruncated;
  const responseTruncated = complete.responseBodyTruncated === true || capture.responseTruncated;
  return {
    startedDateTime: complete.startedDateTime,
    time: complete.time,
    request,
    response,
    cache: complete.cache,
    timings: complete.timings,
    ...(complete.serverIPAddress ? { serverIPAddress: complete.serverIPAddress } : {}),
    ...(complete.connection ? { connection: complete.connection } : {}),
    _limrun: {
      requestId: complete.requestId,
      tunnelId: complete.tunnelId,
      selectorId: complete.selectorId,
      protocol: complete.protocol,
      tls: complete.tls,
      ...(complete.grpc ? { grpc: true } : {}),
      ...(complete.webSocket ? { webSocket: true } : {}),
      ...(complete.error ? { error: complete.error } : {}),
      requestBodyTruncated: requestTruncated,
      responseBodyTruncated: responseTruncated,
      gap: capture.gap,
    },
  };
}

function addRequestBody(request: DestinationTunnelInspectionRequest, body: Buffer): TunnelHarRequest {
  const { postData, ...base } = request;
  const result: TunnelHarRequest = base;
  const mimeType = request.postData?.mimeType ?? headerValue(request.headers, 'content-type');
  if (body.length > 0) {
    const encoded = encodedBody(body, mimeType);
    result.postData = {
      mimeType: mimeType ?? '',
      text: encoded.text,
      ...(encoded.encoding ? { _encoding: encoded.encoding } : {}),
    };
  } else if (postData?.params) {
    result.postData = { mimeType: mimeType ?? '', params: postData.params };
  }
  return result;
}

function addResponseBody(response: DestinationTunnelInspectionResponse, body: Buffer): TunnelHarResponse {
  const { trailers, ...base } = response;
  return {
    ...base,
    content: {
      ...response.content,
      mimeType: response.content.mimeType ?? '',
      ...(body.length > 0 ? encodedBody(body, response.content.mimeType) : {}),
    },
    ...(trailers ? { _trailers: trailers } : {}),
  };
}

function encodedBody(body: Buffer, contentType: string | undefined): { text: string; encoding?: string } {
  if (isTextualContentType(contentType)) {
    return { text: body.toString('utf8') };
  }
  return { text: body.toString('base64'), encoding: 'base64' };
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

async function copySpoolRecords(
  partialPath: string,
  type: SpoolRecord['type'],
  output: number,
): Promise<void> {
  const lines = readline.createInterface({
    input: fs.createReadStream(partialPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of lines) {
    const record = parseSpoolRecord(line);
    if (!record || record.type !== type) continue;
    if (!first) fs.writeSync(output, ',');
    fs.writeSync(output, JSON.stringify(record.type === 'entry' ? record.entry : record.gap));
    first = false;
  }
}

function parseSpoolRecord(line: string): SpoolRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as Partial<SpoolRecord>;
    if (value.type === 'entry' && typeof value.entry === 'object' && value.entry !== null) {
      return { type: 'entry', entry: value.entry as TunnelHarEntry };
    }
    if (value.type === 'gap' && typeof value.gap === 'object' && value.gap !== null) {
      const gap = value.gap as DestinationTunnelInspectionGap;
      if (
        Number.isSafeInteger(gap.fromSequence) &&
        Number.isSafeInteger(gap.toSequence) &&
        typeof gap.message === 'string'
      ) {
        return { type: 'gap', gap };
      }
    }
  } catch {
    // A crash may leave one torn final record; earlier newline-delimited
    // records remain recoverable and are still finalized.
  }
  return undefined;
}

function ensureAppendBoundary(partialPath: string): void {
  try {
    const descriptor = fs.openSync(partialPath, 'r+');
    try {
      fs.fchmodSync(descriptor, 0o600);
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return;
      const byte = Buffer.alloc(1);
      fs.readSync(descriptor, byte, 0, 1, size - 1);
      if (byte[0] !== 0x0a) fs.writeSync(descriptor, '\n', size, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
