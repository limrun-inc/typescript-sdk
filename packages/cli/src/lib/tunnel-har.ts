import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { Entry as HAREntry, Request as HARRequest, Response as HARResponse } from 'har-format';
import {
  type DestinationTunnelInspectionComplete,
  type DestinationTunnelInspectionEvent,
  type DestinationTunnelInspectionExtension,
  type DestinationTunnelInspectionGap,
} from '@limrun/api';

interface PendingCapture {
  requestBody: Buffer[];
  requestBytes: number;
  requestTruncated: boolean;
  responseBody: Buffer[];
  responseBytes: number;
  responseTruncated: boolean;
}

type TunnelHarExtension = DestinationTunnelInspectionExtension & {
  requestBodyEncoding?: 'base64';
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
};

type TunnelHarEntry = HAREntry & { _limrun: TunnelHarExtension };

type SpoolRecord =
  | { type: 'entry'; entry: TunnelHarEntry }
  | { type: 'gap'; gap: DestinationTunnelInspectionGap };

export interface TunnelHarRecorder {
  onEvent: (event: DestinationTunnelInspectionEvent) => void;
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
      };
      pending.set(requestId, state);
    }
    return state;
  };

  const appendRecord = (record: SpoolRecord): void => {
    if (closed) return;
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
  };

  const onEvent = (event: DestinationTunnelInspectionEvent): void => {
    if (closed) return;
    if (event.type === 'gap') {
      appendRecord({ type: 'gap', gap: event.data });
      return;
    }
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
      const gaps = await copySpoolRecords(partialPath, output);
      fs.writeSync(output, '],"_limrun":{"gaps":[');
      fs.writeSync(output, gaps.map((gap) => JSON.stringify(gap)).join(','));
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

  return { onEvent, finalize, close };
}

export function formatInspectionSummary(event: DestinationTunnelInspectionComplete): string {
  const outcome = event._limrun.error ? `ERROR ${event._limrun.error}` : String(event.response.status);
  return `${event.request.method} ${event.request.url} ${outcome} ${event.time}ms ${event.response.bodySize} B`;
}

function makeHarEntry(
  complete: DestinationTunnelInspectionComplete,
  capture: PendingCapture,
): TunnelHarEntry {
  const requestBody = Buffer.concat(capture.requestBody, capture.requestBytes);
  const responseBody = Buffer.concat(capture.responseBody, capture.responseBytes);
  const { request, encoding: requestBodyEncoding } = addRequestBody(complete.request, requestBody);
  const response = addResponseBody(complete.response, responseBody);
  const requestTruncated = complete._limrun.requestBodyTruncated === true || capture.requestTruncated;
  const responseTruncated = complete._limrun.responseBodyTruncated === true || capture.responseTruncated;
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

function addRequestBody(request: HARRequest, body: Buffer): { request: HARRequest; encoding?: 'base64' } {
  if (body.length === 0) return { request };
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

function addResponseBody(response: HARResponse, body: Buffer): HARResponse {
  if (body.length === 0) return response;
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

function encodedBody(body: Buffer, contentType: string | undefined): { text: string; encoding?: 'base64' } {
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
  output: number,
): Promise<DestinationTunnelInspectionGap[]> {
  const lines = readline.createInterface({
    input: fs.createReadStream(partialPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let first = true;
  const gaps: DestinationTunnelInspectionGap[] = [];
  for await (const line of lines) {
    const record = parseSpoolRecord(line);
    if (!record) continue;
    if (record.type === 'gap') {
      gaps.push(record.gap);
      continue;
    }
    if (!first) fs.writeSync(output, ',');
    fs.writeSync(output, JSON.stringify(record.entry));
    first = false;
  }
  return gaps;
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
