import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  DestinationTunnelHARAssembler,
  type DestinationTunnelHAREntry,
  type DestinationTunnelInspectionComplete,
  type DestinationTunnelInspectionEvent,
  type DestinationTunnelInspectionGap,
} from '@limrun/api';

type SpoolRecord =
  | { type: 'entry'; entry: DestinationTunnelHAREntry }
  | { type: 'gap'; gap: DestinationTunnelInspectionGap };

export interface TunnelHarRecorder {
  onEvent: (event: DestinationTunnelInspectionEvent) => void;
  resetPending: () => void;
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
  const assembler = new DestinationTunnelHARAssembler(bodyLimit);
  let closed = false;

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
    const entry = assembler.add(event);
    if (entry) appendRecord({ type: 'entry', entry });
  };

  const resetPending = (): void => {
    assembler.reset();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    assembler.reset();
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

  return { onEvent, resetPending, finalize, close };
}

export function formatInspectionSummary(event: DestinationTunnelInspectionComplete): string {
  const outcome = event._limrun.error ? `ERROR ${event._limrun.error}` : String(event.response.status);
  return `${event.request.method} ${event.request.url} ${outcome} ${event.time}ms ${event.response.bodySize} B`;
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
      return { type: 'entry', entry: value.entry as DestinationTunnelHAREntry };
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
