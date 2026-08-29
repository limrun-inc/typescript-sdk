import crypto from 'crypto';
import net from 'net';
import { domainToASCII } from 'url';
import {
  DestinationTunnelProtocolError,
  readArray,
  readBoolean,
  readInteger,
  readOptionalNonNegativeInteger,
  readOptionalString,
  readRecord,
  readString,
} from './internal/destination-tunnel-wire-reader';

export { DestinationTunnelProtocolError } from './internal/destination-tunnel-wire-reader';

export const DESTINATION_TUNNEL_VERSION = 1;
export const DESTINATION_TUNNEL_MAX_ROUTES = 10;
export const DESTINATION_TUNNEL_MAX_DOMAINS = 64;
export const DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES = 4;
/**
 * IPv4 range used by the device side for synthetic (fake) DNS answers of
 * matched domain selectors.
 */
export const DESTINATION_TUNNEL_FAKE_RANGE = '198.18.0.0/15';
/** Upper bound for per-flow receive windows advertised in open/openOk. */
export const DESTINATION_TUNNEL_MAX_WINDOW = 64 * 1024 * 1024;
/** Default receive window advertised by generic SDK tunnel clients. */
export const DESTINATION_TUNNEL_DEFAULT_WINDOW = 1024 * 1024;
/** Upper bound for a single windowUpdate increment. */
export const DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT = 0x7fff_ffff;
export const DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DESTINATION_TUNNEL_MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface DestinationTunnelRoute {
  host: string;
  port: number;
}

/** Canonical selector values carried by the public protocol. */
export type DestinationTunnelSelectors = string[];

/** Internal classification used to enforce and dial canonical selectors. */
export interface DestinationTunnelSelectorCatalog {
  routes?: DestinationTunnelRoute[];
  domains?: string[];
}

export interface DestinationTunnelInspectionConfig {
  enabled: boolean;
  captureBodies: boolean;
  maxBodyBytes: number;
}

export type DestinationTunnelTransportType = 'tcp' | 'tls';

export type DestinationTunnelTransportRequest =
  | { type: 'tcp' }
  | {
      type: 'tls';
      serverName: string;
      alpnProtocols: string[];
    };

export interface DestinationTunnelTransportResult {
  type: DestinationTunnelTransportType;
  alpnProtocol?: string;
  remoteAddress?: string;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
}

export type DestinationTunnelSelectorKind = 'route' | 'domain';

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
  | 'selector_not_allowed'
  | 'tls_handshake_failed'
  | 'tls_validation_failed'
  | 'tls_protocol_error'
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
  | 'invalid_selector'
  | 'already_active'
  | 'unavailable'
  | 'internal'
  | (string & {});

export type DestinationTunnelClientMessage =
  | {
      type: 'start';
      version: number;
      selectors: DestinationTunnelSelectors;
      inspection: DestinationTunnelInspectionConfig;
      /** Default per-flow receive window this client grants. */
      window: number;
    }
  | {
      type: 'openOk';
      connId: number;
      transport: DestinationTunnelTransportResult;
      window: number;
    }
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
      selectors: DestinationTunnelSelectorReport[];
      configHash: string;
    }
  | {
      type: 'open';
      connId: number;
      selectorId: string;
      host: string;
      port: number;
      transport: DestinationTunnelTransportRequest;
      /** Server's receive window for this flow. */
      window: number;
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
  | 'duplicate';

export class DestinationTunnelSelectorError extends Error {
  constructor(
    readonly code: DestinationTunnelSelectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationTunnelSelectorError';
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
    throw new DestinationTunnelSelectorError('empty', 'at least one tunnel route is required');
  }
  if (routes.length > DESTINATION_TUNNEL_MAX_ROUTES) {
    throw new DestinationTunnelSelectorError(
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
      throw new DestinationTunnelSelectorError(
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
  selectors: readonly string[],
  options: { minRoutePort?: number } = {},
): DestinationTunnelSelectors {
  if (!Array.isArray(selectors)) {
    throw new DestinationTunnelSelectorError('invalid_host', 'tunnel selectors must be an array');
  }
  if (selectors.length === 0) {
    throw new DestinationTunnelSelectorError('empty', 'at least one tunnel selector is required');
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  let routeCount = 0;
  let domainCount = 0;
  for (const selector of selectors) {
    const parsed = parseDestinationTunnelSelector(selector, options.minRoutePort);
    if (parsed.route) routeCount++;
    else domainCount++;
    if (routeCount > DESTINATION_TUNNEL_MAX_ROUTES) {
      throw new DestinationTunnelSelectorError(
        'too_many',
        `at most ${DESTINATION_TUNNEL_MAX_ROUTES} exact tunnel selectors are allowed`,
      );
    }
    if (domainCount > DESTINATION_TUNNEL_MAX_DOMAINS) {
      throw new DestinationTunnelSelectorError(
        'too_many',
        `at most ${DESTINATION_TUNNEL_MAX_DOMAINS} domain tunnel selectors are allowed`,
      );
    }
    if (seen.has(parsed.value)) {
      throw new DestinationTunnelSelectorError('duplicate', `duplicate tunnel selector ${parsed.value}`);
    }
    seen.add(parsed.value);
    canonical.push(parsed.value);
  }
  return canonical;
}

export function classifyDestinationTunnelSelectors(
  selectors: readonly string[],
  options: { minRoutePort?: number } = {},
): DestinationTunnelSelectorCatalog {
  const canonical = validateDestinationTunnelSelectors(selectors, options);
  const routes: DestinationTunnelRoute[] = [];
  const domains: string[] = [];
  for (const selector of canonical) {
    const parsed = parseDestinationTunnelSelector(selector, options.minRoutePort);
    if (parsed.route) routes.push(parsed.route);
    else domains.push(parsed.domain!);
  }
  return {
    ...(routes.length > 0 ? { routes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };
}

export function validateDestinationTunnelDomains(domains: readonly string[]): string[] {
  if (domains.length > DESTINATION_TUNNEL_MAX_DOMAINS) {
    throw new DestinationTunnelSelectorError(
      'too_many',
      `at most ${DESTINATION_TUNNEL_MAX_DOMAINS} tunnel domains are allowed`,
    );
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const domain of domains) {
    const normalized = canonicalizeDestinationTunnelDomain(domain);
    if (seen.has(normalized)) {
      throw new DestinationTunnelSelectorError('duplicate', `duplicate tunnel domain ${normalized}`);
    }
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}

/**
 * Deterministic hash of the canonical selector configuration. Servers echo it
 * in `ready` so clients can detect config mismatches across reconnects. The
 * hashed JSON has fixed key order.
 */
export function destinationTunnelConfigHash(
  selectors: DestinationTunnelSelectors,
  inspection: DestinationTunnelInspectionConfig = disabledDestinationTunnelInspection(),
): string {
  const canonical = validateDestinationTunnelSelectors(selectors);
  const canonicalInspection = normalizeDestinationTunnelInspection(inspection);
  const parts: string[] = [
    `"version":${DESTINATION_TUNNEL_VERSION}`,
    `"selectors":[${canonical.map((selector) => JSON.stringify(selector)).join(',')}]`,
  ];
  parts.push(
    `"inspection":{"enabled":${canonicalInspection.enabled},"captureBodies":${canonicalInspection.captureBodies},"maxBodyBytes":${canonicalInspection.maxBodyBytes}}`,
  );
  return crypto
    .createHash('sha256')
    .update(`{${parts.join(',')}}`, 'utf8')
    .digest('hex');
}

export function normalizeDestinationTunnelInspection(
  inspection: Partial<DestinationTunnelInspectionConfig>,
): DestinationTunnelInspectionConfig {
  const enabled = inspection.enabled ?? false;
  const captureBodies = inspection.captureBodies ?? false;
  const maxBodyBytes = inspection.maxBodyBytes ?? DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES;
  if (captureBodies && !enabled) {
    throw new DestinationTunnelProtocolError('captureBodies requires inspection to be enabled');
  }
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > DESTINATION_TUNNEL_MAX_BODY_BYTES
  ) {
    throw new DestinationTunnelProtocolError(
      `maxBodyBytes must be an integer between 1 and ${DESTINATION_TUNNEL_MAX_BODY_BYTES}`,
    );
  }
  return { enabled, captureBodies, maxBodyBytes };
}

export function disabledDestinationTunnelInspection(): DestinationTunnelInspectionConfig {
  return normalizeDestinationTunnelInspection({ enabled: false, captureBodies: false });
}

/** Selector IDs are one-based positions in the canonical selector array. */
export function destinationTunnelSelectorIds(selectors: DestinationTunnelSelectors): string[] {
  return validateDestinationTunnelSelectors(selectors).map((_, index) => `selector-${index + 1}`);
}

export function destinationTunnelDomainMatches(pattern: string, host: string): boolean {
  const candidate = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return candidate.length > base.length + 1 && candidate.endsWith(`.${base}`);
  }
  return candidate === pattern;
}

/**
 * Verify a server OPEN against the negotiated selectors. Every OPEN must name
 * a known selector ID and a target that the selector actually covers.
 */
export function assertDestinationTunnelOpenAllowed(
  message: Extract<DestinationTunnelServerMessage, { type: 'open' }>,
  selectors: DestinationTunnelSelectors,
): DestinationTunnelSelectorKind {
  const canonical = validateDestinationTunnelSelectors(selectors);
  const match = /^selector-([1-9]\d*)$/.exec(message.selectorId);
  const index = match?.[1] ? Number(match[1]) - 1 : -1;
  const fail = (): never => {
    throw new DestinationTunnelProtocolError(
      `server requested undeclared selector ${message.selectorId} ${message.host}:${message.port}`,
    );
  };
  if (index < 0) fail();
  if (message.port === 53) fail();
  const selector = canonical[index];
  if (selector === undefined) return fail();
  const parsed = parseDestinationTunnelSelector(selector);
  if (parsed.route) {
    if (message.host !== parsed.route.host || message.port !== parsed.route.port) fail();
    return 'route';
  }
  if (!destinationTunnelDomainMatches(parsed.domain!, message.host)) fail();
  return 'domain';
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
      const selectors = validateDestinationTunnelSelectors(
        readArray(record, 'selectors').map((value) => {
          if (typeof value !== 'string') {
            throw new DestinationTunnelProtocolError('tunnel selector must be a string');
          }
          return value;
        }),
      );
      const inspection = readInspectionConfig(record);
      return JSON.stringify({
        type,
        version,
        selectors,
        inspection,
        window: readWindow(record),
      });
    }
    case 'openOk':
      return JSON.stringify({
        type,
        connId: readConnectionId(record),
        transport: readTransportResult(record),
        window: readWindow(record),
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
        selectors: readArray(message, 'selectors').map((value, index) =>
          readSelectorReport(value, `selector-${index + 1}`),
        ),
        configHash: readString(message, 'configHash'),
      };
    case 'open':
      return {
        type,
        connId: readConnectionId(message),
        selectorId: readString(message, 'selectorId'),
        host: readString(message, 'host'),
        port: readPort(message, 'port'),
        transport: readTransportRequest(message),
        window: readWindow(message),
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

function parseDestinationTunnelSelector(
  selector: string,
  minRoutePort = 1,
): { value: string; route?: DestinationTunnelRoute; domain?: string } {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new DestinationTunnelSelectorError('empty', 'tunnel selector must not be empty');
  }
  if (!selector.startsWith('[') && !selector.includes(':')) {
    const domain = canonicalizeDestinationTunnelDomain(selector);
    return { value: domain, domain };
  }

  let host: string;
  let portText: string;
  if (selector.startsWith('[')) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(selector);
    if (!match?.[1] || !match[2]) {
      throw new DestinationTunnelSelectorError('invalid_host', `invalid tunnel selector ${selector}`);
    }
    host = match[1];
    portText = match[2];
  } else {
    const separator = selector.lastIndexOf(':');
    if (separator <= 0 || selector.indexOf(':') !== separator) {
      throw new DestinationTunnelSelectorError('invalid_host', `invalid tunnel selector ${selector}`);
    }
    host = selector.slice(0, separator);
    portText = selector.slice(separator + 1);
  }
  if (!/^\d+$/.test(portText)) {
    throw new DestinationTunnelSelectorError('invalid_port', `invalid tunnel selector port ${portText}`);
  }
  const route = canonicalizeDestinationTunnelRoute({ host, port: Number(portText) }, minRoutePort);
  const formattedHost = route.host.includes(':') ? `[${route.host}]` : route.host;
  return { value: `${formattedHost}:${route.port}`, route };
}

function canonicalizeDestinationTunnelRoute(
  route: DestinationTunnelRoute,
  minPort = 1,
): DestinationTunnelRoute {
  if (!Number.isInteger(route.port) || route.port < minPort || route.port > 65_535 || route.port === 53) {
    throw new DestinationTunnelSelectorError('invalid_port', `invalid tunnel route port ${route.port}`);
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
      throw new DestinationTunnelSelectorError('invalid_host', `invalid tunnel route host ${route.host}`);
    }
    return { host: canonicalizeIPv6(canonical), port: route.port };
  }

  throw new DestinationTunnelSelectorError('invalid_host', `invalid tunnel route host ${route.host}`);
}

function canonicalizeDestinationTunnelDomain(domain: string): string {
  const invalid = (): never => {
    throw new DestinationTunnelSelectorError('invalid_domain', `invalid tunnel domain ${domain}`);
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

function canonicalizeIPv6(host: string): string {
  const mappedIPv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mappedIPv4?.[1] || !mappedIPv4[2]) {
    return host;
  }
  const high = Number.parseInt(mappedIPv4[1], 16);
  const low = Number.parseInt(mappedIPv4[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function readSelectorReport(value: unknown, expectedId: string): DestinationTunnelSelectorReport {
  const report = readRecord(value, 'tunnel selector');
  const id = readString(report, 'id');
  if (id !== expectedId) {
    throw new DestinationTunnelProtocolError(`invalid tunnel selector id ${id}`);
  }
  const kind = readString(report, 'kind');
  if (kind !== 'route' && kind !== 'domain') {
    throw new DestinationTunnelProtocolError(`invalid tunnel selector kind ${kind}`);
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

function readInspectionConfig(record: Record<string, unknown>): DestinationTunnelInspectionConfig {
  const inspection = readRecord(record['inspection'], 'inspection');
  const enabled = readBoolean(inspection, 'enabled');
  const captureBodies = readBoolean(inspection, 'captureBodies');
  const maxBodyBytes = readInteger(inspection, 'maxBodyBytes');
  return normalizeDestinationTunnelInspection({ enabled, captureBodies, maxBodyBytes });
}

function readTransportRequest(record: Record<string, unknown>): DestinationTunnelTransportRequest {
  const transport = readRecord(record['transport'], 'transport');
  const type = readString(transport, 'type');
  if (type === 'tcp') {
    return { type };
  }
  if (type === 'tls') {
    const serverName = readString(transport, 'serverName');
    if (serverName.length === 0) {
      throw new DestinationTunnelProtocolError('TLS transport requires serverName');
    }
    const alpnProtocols = readArray(transport, 'alpnProtocols').map((protocol) => {
      if (typeof protocol !== 'string' || protocol.length === 0) {
        throw new DestinationTunnelProtocolError('alpnProtocols must contain non-empty strings');
      }
      return protocol;
    });
    return { type, serverName, alpnProtocols };
  }
  throw new DestinationTunnelProtocolError(`unsupported tunnel transport ${type}`);
}

function readTransportResult(record: Record<string, unknown>): DestinationTunnelTransportResult {
  const transport = readRecord(record['transport'], 'transport');
  const type = readString(transport, 'type');
  if (type !== 'tcp' && type !== 'tls') {
    throw new DestinationTunnelProtocolError(`unsupported tunnel transport ${type}`);
  }
  return {
    type,
    ...readOptionalString(transport, 'alpnProtocol'),
    ...readOptionalString(transport, 'remoteAddress'),
    ...readOptionalNonNegativeInteger(transport, 'dnsMs'),
    ...readOptionalNonNegativeInteger(transport, 'connectMs'),
    ...readOptionalNonNegativeInteger(transport, 'tlsMs'),
  };
}

function readPort(record: Record<string, unknown>, key: string): number {
  const value = readInteger(record, key);
  if (value < 1 || value > 65_535) {
    throw new DestinationTunnelProtocolError(`${key} must be between 1 and 65535`);
  }
  return value;
}

function readWindow(record: Record<string, unknown>): number {
  const value = readInteger(record, 'window');
  if (value < 1 || value > DESTINATION_TUNNEL_MAX_WINDOW) {
    throw new DestinationTunnelProtocolError(
      `window must be an integer between 1 and ${DESTINATION_TUNNEL_MAX_WINDOW}`,
    );
  }
  return value;
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
