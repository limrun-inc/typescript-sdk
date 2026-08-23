import crypto from 'crypto';
import net from 'net';
import { domainToASCII } from 'url';

export const DESTINATION_TUNNEL_VERSION = 1;
export const DESTINATION_TUNNEL_MAX_ROUTES = 10;
export const DESTINATION_TUNNEL_MAX_DOMAINS = 64;
export const DESTINATION_TUNNEL_MAX_CIDRS = 16;
export const DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES = 4;
/**
 * IPv4 range used by the device side for synthetic (fake) DNS answers of
 * matched domain selectors. CIDR selectors must not overlap it.
 */
export const DESTINATION_TUNNEL_FAKE_RANGE = '198.18.0.0/15';
/** Upper bound for per-flow receive windows advertised in open/openOk. */
export const DESTINATION_TUNNEL_MAX_WINDOW = 64 * 1024 * 1024;
/** Upper bound for a single windowUpdate increment. */
export const DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT = 0x7fff_ffff;

export interface DestinationTunnelRoute {
  host: string;
  port: number;
}

/**
 * Typed TCP selectors negotiated in `start` and echoed back in `ready`.
 * Routes are exact localhost/literal-IP destinations (iOS v1 behavior),
 * domains are exact or `*.` label-bound wildcard names, and cidrs are
 * IPv4 networks. At least one selector of any kind is required.
 */
export interface DestinationTunnelSelectors {
  routes?: DestinationTunnelRoute[];
  domains?: string[];
  cidrs?: string[];
}

export type DestinationTunnelSelectorKind = 'route' | 'domain' | 'cidr';

export type DestinationTunnelBindStatus = 'ok' | 'conflict' | 'error';

/** Per-address bind outcome the device server reports for exact routes. */
export interface DestinationTunnelBindReport {
  address: string;
  status: DestinationTunnelBindStatus;
  osCode?: string;
}

/** Normalized selector the server acknowledges in `ready` and status. */
export interface DestinationTunnelSelectorReport {
  id: string;
  kind: DestinationTunnelSelectorKind;
  value: string;
  binds?: DestinationTunnelBindReport[];
}

export type DestinationTunnelOpenFailureReason =
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

export type DestinationTunnelResetReason =
  | 'cancelled'
  | 'connection_error'
  | 'protocol_error'
  | 'resource_exhausted'
  | 'internal'
  | (string & {});

export type DestinationTunnelSessionErrorCode =
  | 'unsupported_version'
  | 'invalid_message'
  | 'invalid_route'
  | 'invalid_selector'
  | 'route_capacity'
  | 'already_active'
  | 'unavailable'
  | 'internal'
  | (string & {});

export type DestinationTunnelClientMessage =
  | {
      type: 'start';
      version: number;
      routes?: DestinationTunnelRoute[];
      domains?: string[];
      cidrs?: string[];
      /** Default per-flow receive window this client grants. Absent disables credit. */
      window?: number;
    }
  | { type: 'openOk'; connId: number; window?: number }
  | {
      type: 'openFail';
      connId: number;
      reason: DestinationTunnelOpenFailureReason;
      osCode?: string;
    }
  | { type: 'fin'; connId: number }
  | { type: 'reset'; connId: number; reason: DestinationTunnelResetReason; osCode?: string }
  | { type: 'windowUpdate'; connId: number; increment: number };

export type DestinationTunnelServerMessage =
  | {
      type: 'ready';
      version: number;
      tunnelId: string;
      selectors?: DestinationTunnelSelectorReport[];
      configHash?: string;
    }
  | {
      type: 'open';
      connId: number;
      /** Selector ID (route-N, domain-N, or cidr-N). Wire name kept from v1. */
      routeId: string;
      host: string;
      port: number;
      proto: 'tcp';
      /** Server's receive window for this flow. Absent disables credit. */
      window?: number;
    }
  | { type: 'fin'; connId: number }
  | { type: 'reset'; connId: number; reason: DestinationTunnelResetReason; osCode?: string }
  | { type: 'windowUpdate'; connId: number; increment: number }
  | { type: 'error'; code: DestinationTunnelSessionErrorCode };

export type DestinationTunnelSelectorErrorCode =
  | 'empty'
  | 'too_many'
  | 'invalid_host'
  | 'invalid_port'
  | 'invalid_domain'
  | 'invalid_cidr'
  | 'overlap'
  | 'duplicate';

export type DestinationTunnelRouteErrorCode = DestinationTunnelSelectorErrorCode;

export class DestinationTunnelRouteError extends Error {
  constructor(
    readonly code: DestinationTunnelSelectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationTunnelRouteError';
  }
}

/** Alias: selector validation reuses the route error class for compatibility. */
export const DestinationTunnelSelectorError = DestinationTunnelRouteError;

export class DestinationTunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationTunnelProtocolError';
  }
}

export function encodeDestinationTunnelDataFrame(connId: number, payload: Buffer): Buffer {
  validateConnectionId(connId);
  if (payload.length === 0) {
    throw new DestinationTunnelProtocolError('tunnel data frame must include a payload');
  }
  const frame = Buffer.allocUnsafe(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES + payload.length);
  frame.writeUInt32BE(connId, 0);
  payload.copy(frame, DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES);
  return frame;
}

export function decodeDestinationTunnelDataFrame(frame: Buffer): {
  connId: number;
  payload: Buffer;
} {
  if (frame.length <= DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES) {
    throw new DestinationTunnelProtocolError('tunnel data frame must include a payload');
  }
  return {
    connId: frame.readUInt32BE(0),
    payload: frame.subarray(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES),
  };
}

export function validateDestinationTunnelRoutes(
  routes: readonly DestinationTunnelRoute[],
  options: { minPort?: number } = {},
): DestinationTunnelRoute[] {
  if (routes.length === 0) {
    throw new DestinationTunnelRouteError('empty', 'at least one tunnel route is required');
  }
  if (routes.length > DESTINATION_TUNNEL_MAX_ROUTES) {
    throw new DestinationTunnelRouteError(
      'too_many',
      `at most ${DESTINATION_TUNNEL_MAX_ROUTES} tunnel routes are allowed`,
    );
  }

  const canonicalRoutes: DestinationTunnelRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const canonical = canonicalizeDestinationTunnelRoute(route, options.minPort);
    const key = `${canonical.host}\0${canonical.port}`;
    if (seen.has(key)) {
      throw new DestinationTunnelRouteError(
        'duplicate',
        `duplicate tunnel route ${canonical.host}:${canonical.port}`,
      );
    }
    seen.add(key);
    canonicalRoutes.push(canonical);
  }
  return canonicalRoutes;
}

/**
 * Validate and canonicalize a full selector set. Selector policy specific to
 * one product (such as the Android bind-listener minimum route port) is
 * expressed via options rather than separate message shapes.
 */
export function validateDestinationTunnelSelectors(
  selectors: DestinationTunnelSelectors,
  options: { minRoutePort?: number } = {},
): DestinationTunnelSelectors {
  const routes = selectors.routes ?? [];
  const domains = selectors.domains ?? [];
  const cidrs = selectors.cidrs ?? [];
  if (routes.length === 0 && domains.length === 0 && cidrs.length === 0) {
    throw new DestinationTunnelRouteError('empty', 'at least one tunnel selector is required');
  }
  const canonical: DestinationTunnelSelectors = {};
  if (routes.length > 0) {
    canonical.routes = validateDestinationTunnelRoutes(
      routes,
      options.minRoutePort === undefined ? {} : { minPort: options.minRoutePort },
    );
  }
  if (domains.length > 0) {
    canonical.domains = validateDestinationTunnelDomains(domains);
  }
  if (cidrs.length > 0) {
    canonical.cidrs = validateDestinationTunnelCidrs(cidrs);
  }
  return canonical;
}

export function validateDestinationTunnelDomains(domains: readonly string[]): string[] {
  if (domains.length > DESTINATION_TUNNEL_MAX_DOMAINS) {
    throw new DestinationTunnelRouteError(
      'too_many',
      `at most ${DESTINATION_TUNNEL_MAX_DOMAINS} tunnel domains are allowed`,
    );
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const domain of domains) {
    const normalized = canonicalizeDestinationTunnelDomain(domain);
    if (seen.has(normalized)) {
      throw new DestinationTunnelRouteError('duplicate', `duplicate tunnel domain ${normalized}`);
    }
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}

export function validateDestinationTunnelCidrs(cidrs: readonly string[]): string[] {
  if (cidrs.length > DESTINATION_TUNNEL_MAX_CIDRS) {
    throw new DestinationTunnelRouteError(
      'too_many',
      `at most ${DESTINATION_TUNNEL_MAX_CIDRS} tunnel CIDRs are allowed`,
    );
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const cidr of cidrs) {
    const normalized = canonicalizeDestinationTunnelCidr(cidr);
    if (seen.has(normalized)) {
      throw new DestinationTunnelRouteError('duplicate', `duplicate tunnel CIDR ${normalized}`);
    }
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}

/**
 * Deterministic hash of the canonical selector configuration. Servers echo it
 * in `ready` so clients can detect config mismatches across reconnects. The
 * hashed JSON has fixed key order and omits empty selector arrays.
 */
export function destinationTunnelConfigHash(selectors: DestinationTunnelSelectors): string {
  const canonical = validateDestinationTunnelSelectors(selectors);
  const parts: string[] = [`"version":${DESTINATION_TUNNEL_VERSION}`];
  if (canonical.routes && canonical.routes.length > 0) {
    const routes = canonical.routes.map((route) => `{"host":${JSON.stringify(route.host)},"port":${route.port}}`);
    parts.push(`"routes":[${routes.join(',')}]`);
  }
  if (canonical.domains && canonical.domains.length > 0) {
    parts.push(`"domains":[${canonical.domains.map((domain) => JSON.stringify(domain)).join(',')}]`);
  }
  if (canonical.cidrs && canonical.cidrs.length > 0) {
    parts.push(`"cidrs":[${canonical.cidrs.map((cidr) => JSON.stringify(cidr)).join(',')}]`);
  }
  return crypto.createHash('sha256').update(`{${parts.join(',')}}`, 'utf8').digest('hex');
}

/** Selector IDs are 1-based per kind: route-1, domain-1, cidr-1, ... */
export function destinationTunnelSelectorIds(selectors: DestinationTunnelSelectors): string[] {
  const ids: string[] = [];
  (selectors.routes ?? []).forEach((_, index) => ids.push(`route-${index + 1}`));
  (selectors.domains ?? []).forEach((_, index) => ids.push(`domain-${index + 1}`));
  (selectors.cidrs ?? []).forEach((_, index) => ids.push(`cidr-${index + 1}`));
  return ids;
}

export function destinationTunnelDomainMatches(pattern: string, host: string): boolean {
  const candidate = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return candidate.length > base.length + 1 && candidate.endsWith(`.${base}`);
  }
  return candidate === pattern;
}

export function destinationTunnelCidrContains(cidr: string, host: string): boolean {
  const [network, lengthText] = cidr.split('/');
  if (!network || lengthText === undefined) return false;
  const prefix = Number(lengthText);
  const hostValue = ipv4ToUint32(host);
  const networkValue = ipv4ToUint32(network);
  if (hostValue === undefined || networkValue === undefined) return false;
  if (prefix === 0) return true;
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return (hostValue & mask) === (networkValue & mask);
}

/**
 * Verify a server OPEN against the negotiated selectors. Every OPEN must name
 * a known selector ID and a target that the selector actually covers.
 */
export function assertDestinationTunnelOpenAllowed(
  message: Extract<DestinationTunnelServerMessage, { type: 'open' }>,
  selectors: DestinationTunnelSelectors | readonly DestinationTunnelRoute[],
): void {
  const normalized: DestinationTunnelSelectors =
    Array.isArray(selectors) ? { routes: selectors as DestinationTunnelRoute[] } : (selectors as DestinationTunnelSelectors);
  if (message.proto !== 'tcp') {
    throw new DestinationTunnelProtocolError(`server requested unsupported transport ${message.proto}`);
  }
  const match = /^(route|domain|cidr)-([1-9]\d*)$/.exec(message.routeId);
  const kind = match?.[1];
  const index = match?.[2] ? Number(match[2]) - 1 : -1;
  const fail = (): never => {
    throw new DestinationTunnelProtocolError(
      `server requested undeclared route ${message.routeId} ${message.host}:${message.port}/${message.proto}`,
    );
  };
  if (!kind || index < 0) fail();
  if (message.port === 53) fail();
  switch (kind) {
    case 'route': {
      const route = normalized.routes?.[index];
      if (!route || message.host !== route.host || message.port !== route.port) fail();
      return;
    }
    case 'domain': {
      const domain = normalized.domains?.[index];
      if (!domain || !destinationTunnelDomainMatches(domain, message.host)) fail();
      return;
    }
    case 'cidr': {
      const cidr = normalized.cidrs?.[index];
      if (!cidr || net.isIP(message.host) !== 4 || !destinationTunnelCidrContains(cidr, message.host)) {
        fail();
      }
      return;
    }
  }
}

export function assertDestinationTunnelReady(
  message: Extract<DestinationTunnelServerMessage, { type: 'ready' }>,
): void {
  if (message.version !== DESTINATION_TUNNEL_VERSION) {
    throw new DestinationTunnelProtocolError(`unsupported tunnel version ${message.version}`);
  }
}

export function encodeDestinationTunnelClientMessage(message: DestinationTunnelClientMessage): string {
  const record = readRecord(message, 'tunnel control message');
  const type = readString(record, 'type');

  switch (type) {
    case 'start': {
      const version = readInteger(record, 'version');
      if (version !== DESTINATION_TUNNEL_VERSION) {
        throw new DestinationTunnelProtocolError(`unsupported tunnel version ${version}`);
      }
      const selectors = validateDestinationTunnelSelectors({
        ...(record['routes'] === undefined ? {} : { routes: readArray(record, 'routes').map(readRoute) }),
        ...(record['domains'] === undefined ? {} : { domains: readArray(record, 'domains').map(readDomain) }),
        ...(record['cidrs'] === undefined ? {} : { cidrs: readArray(record, 'cidrs').map(readCidr) }),
      });
      return JSON.stringify({
        type,
        version,
        ...(selectors.routes ? { routes: selectors.routes } : {}),
        ...(selectors.domains ? { domains: selectors.domains } : {}),
        ...(selectors.cidrs ? { cidrs: selectors.cidrs } : {}),
        ...readOptionalWindow(record),
      });
    }
    case 'openOk':
      return JSON.stringify({
        type,
        connId: readConnectionId(record),
        ...readOptionalWindow(record),
      });
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
    case 'windowUpdate':
      return JSON.stringify({
        type,
        connId: readConnectionId(record),
        increment: readWindowIncrement(record),
      });
    default:
      throw new DestinationTunnelProtocolError(`unknown tunnel control message type ${type}`);
  }
}

export function decodeDestinationTunnelServerMessage(value: unknown): DestinationTunnelServerMessage {
  const message = readRecord(value, 'tunnel control message');
  const type = readString(message, 'type');

  switch (type) {
    case 'ready':
      return {
        type,
        version: readInteger(message, 'version'),
        tunnelId: readString(message, 'tunnelId'),
        ...(message['selectors'] === undefined ?
          {}
        : { selectors: readArray(message, 'selectors').map(readSelectorReport) }),
        ...readOptionalString(message, 'configHash'),
      };
    case 'open':
      return {
        type,
        connId: readConnectionId(message),
        routeId: readString(message, 'routeId'),
        host: readString(message, 'host'),
        port: readPort(message, 'port'),
        proto: readTCP(message),
        ...readOptionalWindow(message),
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
    case 'windowUpdate':
      return {
        type,
        connId: readConnectionId(message),
        increment: readWindowIncrement(message),
      };
    case 'error':
      return { type, code: readString(message, 'code') };
    default:
      throw new DestinationTunnelProtocolError(`unknown tunnel control message type ${type}`);
  }
}

function canonicalizeDestinationTunnelRoute(
  route: DestinationTunnelRoute,
  minPort = 1,
): DestinationTunnelRoute {
  if (
    !Number.isInteger(route.port) ||
    route.port < minPort ||
    route.port > 65_535 ||
    route.port === 53
  ) {
    throw new DestinationTunnelRouteError('invalid_port', `invalid tunnel route port ${route.port}`);
  }

  const asciiHost = Buffer.byteLength(route.host, 'utf8') === route.host.length;
  if (asciiHost && route.host.toLowerCase() === 'localhost') {
    return { host: 'localhost', port: route.port };
  }

  const ipVersion = net.isIP(route.host);
  if (ipVersion === 4) {
    return { host: route.host, port: route.port };
  }
  if (ipVersion === 6) {
    const hostname = new URL(`http://[${route.host}]/`).hostname;
    const canonical = hostname.slice(1, -1);
    if (canonical !== '::1' && /^::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(canonical)) {
      throw new DestinationTunnelRouteError('invalid_host', `invalid tunnel route host ${route.host}`);
    }
    return { host: canonicalizeIPv6(canonical), port: route.port };
  }

  throw new DestinationTunnelRouteError('invalid_host', `invalid tunnel route host ${route.host}`);
}

function canonicalizeDestinationTunnelDomain(domain: string): string {
  const invalid = (): never => {
    throw new DestinationTunnelRouteError('invalid_domain', `invalid tunnel domain ${domain}`);
  };
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 260) invalid();
  // ASCII only: reject anything IDNA mapping would change to avoid ambiguity
  // between implementations. Users provide punycode (xn--) names directly.
  if (Buffer.byteLength(domain, 'utf8') !== domain.length) invalid();
  const lowered = domain.toLowerCase();
  const wildcard = lowered.startsWith('*.');
  const base = wildcard ? lowered.slice(2) : lowered;
  if (base.length === 0 || base.length > 253) invalid();
  if (base.includes('*')) invalid();
  if (base.endsWith('.') || base.startsWith('.')) invalid();
  if (net.isIP(base) !== 0) invalid();
  if (base === 'localhost') invalid();
  if (domainToASCII(base) !== base) invalid();
  const labels = base.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) invalid();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) invalid();
  }
  // All-numeric final labels would be ambiguous with IPv4 literals.
  const finalLabel = labels[labels.length - 1];
  if (finalLabel !== undefined && /^\d+$/.test(finalLabel)) invalid();
  return wildcard ? `*.${base}` : base;
}

function canonicalizeDestinationTunnelCidr(cidr: string): string {
  const invalid = (code: 'invalid_cidr' | 'overlap' = 'invalid_cidr'): never => {
    throw new DestinationTunnelRouteError(
      code,
      code === 'overlap' ?
        `tunnel CIDR ${cidr} overlaps the reserved fake range ${DESTINATION_TUNNEL_FAKE_RANGE}`
      : `invalid tunnel CIDR ${cidr}`,
    );
  };
  if (typeof cidr !== 'string') invalid();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (!match) invalid();
  const prefix = Number(match![5]);
  if (prefix < 8 || prefix > 32) invalid();
  const address = `${Number(match![1])}.${Number(match![2])}.${Number(match![3])}.${Number(match![4])}`;
  if (address !== `${match![1]}.${match![2]}.${match![3]}.${match![4]}`) invalid();
  const value = ipv4ToUint32(address);
  if (value === undefined) invalid();
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  if (((value! & mask) >>> 0) !== value!) invalid();

  const blocked: Array<[string, number]> = [
    [DESTINATION_TUNNEL_FAKE_RANGE.split('/')[0]!, 15],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['0.0.0.0', 8],
  ];
  for (const [network, blockedPrefix] of blocked) {
    const blockedValue = ipv4ToUint32(network)!;
    const sharedPrefix = Math.min(prefix, blockedPrefix);
    const sharedMask = sharedPrefix === 0 ? 0 : (0xffff_ffff << (32 - sharedPrefix)) >>> 0;
    if ((value! & sharedMask) === (blockedValue & sharedMask)) {
      invalid(network === DESTINATION_TUNNEL_FAKE_RANGE.split('/')[0] ? 'overlap' : 'invalid_cidr');
    }
  }
  return `${address}/${prefix}`;
}

function ipv4ToUint32(address: string): number | undefined {
  if (net.isIP(address) !== 4) return undefined;
  const octets = address.split('.').map(Number);
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function canonicalizeIPv6(host: string): string {
  const mappedIPv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mappedIPv4?.[1] || !mappedIPv4[2]) {
    return host;
  }
  const high = Number.parseInt(mappedIPv4[1], 16);
  const low = Number.parseInt(mappedIPv4[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function readRoute(value: unknown): DestinationTunnelRoute {
  const route = readRecord(value, 'tunnel route');
  return {
    host: readString(route, 'host'),
    port: readPort(route, 'port'),
  };
}

function readDomain(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError('tunnel domain must be a string');
  }
  return value;
}

function readCidr(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError('tunnel CIDR must be a string');
  }
  return value;
}

function readSelectorReport(value: unknown): DestinationTunnelSelectorReport {
  const report = readRecord(value, 'tunnel selector');
  const id = readString(report, 'id');
  if (!/^(route|domain|cidr)-([1-9]\d*)$/.test(id)) {
    throw new DestinationTunnelProtocolError(`invalid tunnel selector id ${id}`);
  }
  const kind = readString(report, 'kind');
  if (kind !== 'route' && kind !== 'domain' && kind !== 'cidr') {
    throw new DestinationTunnelProtocolError(`invalid tunnel selector kind ${kind}`);
  }
  if (!id.startsWith(`${kind}-`)) {
    throw new DestinationTunnelProtocolError(`tunnel selector id ${id} does not match kind ${kind}`);
  }
  const result: DestinationTunnelSelectorReport = {
    id,
    kind,
    value: readString(report, 'value'),
  };
  if (report['binds'] !== undefined) {
    result.binds = readArray(report, 'binds').map(readBindReport);
  }
  return result;
}

function readBindReport(value: unknown): DestinationTunnelBindReport {
  const bind = readRecord(value, 'tunnel bind report');
  const status = readString(bind, 'status');
  if (status !== 'ok' && status !== 'conflict' && status !== 'error') {
    throw new DestinationTunnelProtocolError(`invalid tunnel bind status ${status}`);
  }
  return {
    address: readString(bind, 'address'),
    status,
    ...readOptionalString(bind, 'osCode'),
  };
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be an array`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError(`${key} must be a string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'string') {
    throw new DestinationTunnelProtocolError(`${key} must be a string`);
  }
  return { [key]: value };
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new DestinationTunnelProtocolError(`${key} must be an integer`);
  }
  return value as number;
}

function readPort(record: Record<string, unknown>, key: string): number {
  const value = readInteger(record, key);
  if (value < 1 || value > 65_535) {
    throw new DestinationTunnelProtocolError(`${key} must be between 1 and 65535`);
  }
  return value;
}

function readOptionalWindow(record: Record<string, unknown>): { window?: number } {
  const value = record['window'];
  if (value === undefined) {
    return {};
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > DESTINATION_TUNNEL_MAX_WINDOW) {
    throw new DestinationTunnelProtocolError(
      `window must be an integer between 1 and ${DESTINATION_TUNNEL_MAX_WINDOW}`,
    );
  }
  return { window: value as number };
}

function readWindowIncrement(record: Record<string, unknown>): number {
  const value = readInteger(record, 'increment');
  if (value < 1 || value > DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT) {
    throw new DestinationTunnelProtocolError(
      `increment must be an integer between 1 and ${DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT}`,
    );
  }
  return value;
}

function readConnectionId(record: Record<string, unknown>): number {
  const value = readInteger(record, 'connId');
  validateConnectionId(value);
  return value;
}

function validateConnectionId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new DestinationTunnelProtocolError('connId must be an unsigned 32-bit integer');
  }
}

function readTCP(record: Record<string, unknown>): 'tcp' {
  const value = readString(record, 'proto');
  if (value !== 'tcp') {
    throw new DestinationTunnelProtocolError(`unsupported tunnel transport ${value}`);
  }
  return value;
}
