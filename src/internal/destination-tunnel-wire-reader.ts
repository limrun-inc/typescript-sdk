export class DestinationTunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationTunnelProtocolError';
  }
}

export function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be an array`);
  }
  return value;
}

export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError(`${key} must be a string`);
  }
  return value;
}

export function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (value.length === 0) {
    throw new DestinationTunnelProtocolError(`${key} must not be empty`);
  }
  return value;
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new DestinationTunnelProtocolError(`${key} must be a boolean`);
  }
  return value;
}

export function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be an integer`);
  }
  return value as number;
}

export function readFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be a finite number`);
  }
  return value;
}

export function readSafeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DestinationTunnelProtocolError(`${name} must be a safe non-negative integer`);
  }
  return value as number;
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): { [K in typeof key]?: string } {
  return record[key] === undefined ? {} : { [key]: readString(record, key) };
}

export function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): { [K in typeof key]?: boolean } {
  return record[key] === undefined ? {} : { [key]: readBoolean(record, key) };
}

export function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): { [K in typeof key]?: number } {
  const value = record[key];
  if (value === undefined) return {};
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new DestinationTunnelProtocolError(`${key} must be a non-negative integer`);
  }
  return { [key]: value as number };
}

export function decodeUtf8(value: Buffer, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new DestinationTunnelProtocolError(`${name} must be valid UTF-8`);
  }
}

export function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new DestinationTunnelProtocolError('unsupported WebSocket payload type');
}
