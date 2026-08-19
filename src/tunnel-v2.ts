import net from 'net';

export const TUNNEL_V2_VERSION = 2;
export const TUNNEL_V2_MAX_ROUTES = 10;
export const TUNNEL_V2_CONN_ID_HEADER_BYTES = 4;

export interface TunnelV2Route {
  host: string;
  port: number;
}

export type TunnelV2OpenFailureReason =
  | 'dns_not_found'
  | 'dns_temporary_failure'
  | 'connection_refused'
  | 'connection_reset'
  | 'connection_timed_out'
  | 'unreachable'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'route_not_allowed'
  | 'cancelled'
  | 'internal'
  | (string & {});

export type TunnelV2ResetReason =
  | 'cancelled'
  | 'connection_error'
  | 'protocol_error'
  | 'resource_exhausted'
  | 'internal'
  | (string & {});

export type TunnelV2SessionErrorCode =
  | 'unsupported_version'
  | 'invalid_message'
  | 'invalid_route'
  | 'route_capacity'
  | 'already_active'
  | 'unavailable'
  | 'internal'
  | (string & {});

export type TunnelV2ClientMessage =
  | { type: 'start'; version: number; routes: TunnelV2Route[] }
  | { type: 'openOk'; connId: number }
  | {
      type: 'openFail';
      connId: number;
      reason: TunnelV2OpenFailureReason;
      osCode?: string;
    }
  | { type: 'fin'; connId: number }
  | { type: 'reset'; connId: number; reason: TunnelV2ResetReason; osCode?: string };

export type TunnelV2ServerMessage =
  | { type: 'ready'; version: number; tunnelId: string }
  | {
      type: 'open';
      connId: number;
      routeId: string;
      host: string;
      port: number;
      proto: 'tcp';
    }
  | { type: 'fin'; connId: number }
  | { type: 'reset'; connId: number; reason: TunnelV2ResetReason; osCode?: string }
  | { type: 'error'; code: TunnelV2SessionErrorCode };

export type TunnelV2RouteErrorCode = 'empty' | 'too_many' | 'invalid_host' | 'invalid_port' | 'duplicate';

export class TunnelV2RouteError extends Error {
  constructor(
    readonly code: TunnelV2RouteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TunnelV2RouteError';
  }
}

export class TunnelV2ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelV2ProtocolError';
  }
}

export function validateTunnelV2Routes(routes: readonly TunnelV2Route[]): TunnelV2Route[] {
  if (routes.length === 0) {
    throw new TunnelV2RouteError('empty', 'at least one tunnel route is required');
  }
  if (routes.length > TUNNEL_V2_MAX_ROUTES) {
    throw new TunnelV2RouteError('too_many', `at most ${TUNNEL_V2_MAX_ROUTES} tunnel routes are allowed`);
  }

  const canonicalRoutes: TunnelV2Route[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const canonical = canonicalizeTunnelV2Route(route);
    const key = `${canonical.host}\0${canonical.port}`;
    if (seen.has(key)) {
      throw new TunnelV2RouteError('duplicate', `duplicate tunnel route ${canonical.host}:${canonical.port}`);
    }
    seen.add(key);
    canonicalRoutes.push(canonical);
  }
  return canonicalRoutes;
}

export function assertTunnelV2OpenAllowed(
  message: Extract<TunnelV2ServerMessage, { type: 'open' }>,
  routes: readonly TunnelV2Route[],
): void {
  const index = parseRouteId(message.routeId);
  const route = routes[index];
  if (!route || message.host !== route.host || message.port !== route.port || message.proto !== 'tcp') {
    throw new TunnelV2ProtocolError(
      `server requested undeclared route ${message.routeId} ${message.host}:${message.port}/${message.proto}`,
    );
  }
}

export function assertTunnelV2Ready(message: Extract<TunnelV2ServerMessage, { type: 'ready' }>): void {
  if (message.version !== TUNNEL_V2_VERSION) {
    throw new TunnelV2ProtocolError(`unsupported tunnel version ${message.version}`);
  }
}

export function encodeTunnelV2ClientMessage(message: TunnelV2ClientMessage): string {
  const record = readRecord(message, 'tunnel control message');
  const type = readString(record, 'type');

  switch (type) {
    case 'start': {
      const version = readInteger(record, 'version');
      if (version !== TUNNEL_V2_VERSION) {
        throw new TunnelV2ProtocolError(`unsupported tunnel version ${version}`);
      }
      const routes = validateTunnelV2Routes(readArray(record, 'routes').map(readRoute));
      return JSON.stringify({ type, version, routes });
    }
    case 'openOk':
    case 'fin':
      return JSON.stringify({ type, connId: readConnectionId(record) });
    case 'openFail':
    case 'reset':
      return JSON.stringify({
        type,
        connId: readConnectionId(record),
        reason: readString(record, 'reason'),
        ...readOptionalString(record, 'osCode'),
      });
    default:
      throw new TunnelV2ProtocolError(`unknown tunnel control message type ${type}`);
  }
}

export function decodeTunnelV2ServerMessage(value: unknown): TunnelV2ServerMessage {
  const message = readRecord(value, 'tunnel control message');
  const type = readString(message, 'type');

  switch (type) {
    case 'ready':
      return {
        type,
        version: readInteger(message, 'version'),
        tunnelId: readString(message, 'tunnelId'),
      };
    case 'open':
      return {
        type,
        connId: readConnectionId(message),
        routeId: readString(message, 'routeId'),
        host: readString(message, 'host'),
        port: readPort(message, 'port'),
        proto: readTCP(message),
      };
    case 'fin':
      return { type, connId: readConnectionId(message) };
    case 'reset':
      return {
        type,
        connId: readConnectionId(message),
        reason: readString(message, 'reason'),
        ...readOptionalString(message, 'osCode'),
      };
    case 'error':
      return { type, code: readString(message, 'code') };
    default:
      throw new TunnelV2ProtocolError(`unknown tunnel control message type ${type}`);
  }
}

function canonicalizeTunnelV2Route(route: TunnelV2Route): TunnelV2Route {
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65_535) {
    throw new TunnelV2RouteError('invalid_port', `invalid tunnel route port ${route.port}`);
  }

  const ipVersion = net.isIP(route.host);
  if (ipVersion === 4) {
    return { host: route.host, port: route.port };
  }
  if (ipVersion === 6) {
    const hostname = new URL(`http://[${route.host}]/`).hostname;
    return { host: canonicalizeIPv6(hostname.slice(1, -1)), port: route.port };
  }

  throw new TunnelV2RouteError('invalid_host', `invalid tunnel route host ${route.host}`);
}

function canonicalizeIPv6(host: string): string {
  const embeddedIPv4 = /^(::(?:ffff:)?)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!embeddedIPv4?.[1] || !embeddedIPv4[2] || !embeddedIPv4[3]) {
    return host;
  }
  const high = Number.parseInt(embeddedIPv4[2], 16);
  const low = Number.parseInt(embeddedIPv4[3], 16);
  return `${embeddedIPv4[1]}${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function parseRouteId(routeId: string): number {
  const match = /^route-([1-9]\d*)$/.exec(routeId);
  if (!match?.[1]) {
    return -1;
  }
  return Number(match[1]) - 1;
}

function readRoute(value: unknown): TunnelV2Route {
  const route = readRecord(value, 'tunnel route');
  return {
    host: readString(route, 'host'),
    port: readPort(route, 'port'),
  };
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TunnelV2ProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new TunnelV2ProtocolError(`${key} must be an array`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new TunnelV2ProtocolError(`${key} must be a string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new TunnelV2ProtocolError(`${key} must be a string`);
  }
  return { [key]: value };
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new TunnelV2ProtocolError(`${key} must be an integer`);
  }
  return value as number;
}

function readPort(record: Record<string, unknown>, key: string): number {
  const value = readInteger(record, key);
  if (value < 1 || value > 65_535) {
    throw new TunnelV2ProtocolError(`${key} must be between 1 and 65535`);
  }
  return value;
}

function readConnectionId(record: Record<string, unknown>): number {
  const value = readInteger(record, 'connId');
  if (value < 0 || value > 0xffff_ffff) {
    throw new TunnelV2ProtocolError('connId must be an unsigned 32-bit integer');
  }
  return value;
}

function readTCP(record: Record<string, unknown>): 'tcp' {
  const value = readString(record, 'proto');
  if (value !== 'tcp') {
    throw new TunnelV2ProtocolError(`unsupported tunnel transport ${value}`);
  }
  return value;
}
