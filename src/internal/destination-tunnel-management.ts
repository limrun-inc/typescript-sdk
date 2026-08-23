import { nodeProxyTransport } from './proxy-transport';
import { deriveDestinationTunnelStatusURL, deriveDestinationTunnelStopURL } from './destination-tunnel-url';
import {
  validateDestinationTunnelSelectors,
  type DestinationTunnelRoute,
  type DestinationTunnelBindReport,
} from '../destination-tunnel';

export interface DestinationTunnelStatus {
  active?: {
    tunnelId: string;
    state: 'starting' | 'ready' | 'stopping';
    routes: DestinationTunnelRoute[];
    domains?: string[];
    cidrs?: string[];
    /** Per exact route, the device-side bind outcomes (Android bind listeners). */
    binds?: Record<string, DestinationTunnelBindReport[]>;
  };
  lastFailure?: {
    tunnelId: string;
    code: string;
  };
  lastDialFailure?: {
    tunnelId: string;
    connectionId: number;
    routeId: string;
    reason: string;
    osCode?: string;
  };
}

export async function getDestinationTunnelStatus(
  apiUrl: string,
  token: string,
): Promise<DestinationTunnelStatus> {
  const response = await nodeProxyTransport.fetch(deriveDestinationTunnelStatusURL(apiUrl).toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`getTunnelStatus failed: ${response.status} ${await response.text()}`);
  }
  return decodeDestinationTunnelStatus(await response.json());
}

export async function stopDestinationTunnel(apiUrl: string, token: string, tunnelId: string): Promise<void> {
  if (!tunnelId.trim()) {
    throw new Error('tunnelId must not be empty');
  }
  const response = await nodeProxyTransport.fetch(
    deriveDestinationTunnelStopURL(apiUrl, tunnelId).toString(),
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) {
    throw new Error(`stopTunnel failed: ${response.status} ${await response.text()}`);
  }
}

export function decodeDestinationTunnelStatus(value: unknown): DestinationTunnelStatus {
  const status = readRecord(value, 'tunnel status');
  const decodedStatus: DestinationTunnelStatus = {};
  if (status['active'] !== undefined) {
    decodedStatus.active = readActiveTunnel(status['active']);
  }
  if (status['lastFailure'] !== undefined) {
    decodedStatus.lastFailure = readTunnelFailure(status['lastFailure']);
  }
  if (status['lastDialFailure'] !== undefined) {
    decodedStatus.lastDialFailure = readTunnelDialFailure(status['lastDialFailure']);
  }
  return decodedStatus;
}

function readActiveTunnel(value: unknown): NonNullable<DestinationTunnelStatus['active']> {
  const active = readRecord(value, 'active tunnel');
  const state = readString(active, 'state');
  if (state !== 'starting' && state !== 'ready' && state !== 'stopping') {
    throw new Error(`invalid tunnel state ${state}`);
  }
  const routes = active['routes'] === undefined ? [] : readArray(active, 'routes').map(readTunnelRoute);
  const domains = active['domains'] === undefined ? [] : readArray(active, 'domains').map(readSelectorText);
  const cidrs = active['cidrs'] === undefined ? [] : readArray(active, 'cidrs').map(readSelectorText);
  const selectors = validateDestinationTunnelSelectors({
    ...(routes.length > 0 ? { routes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
    ...(cidrs.length > 0 ? { cidrs } : {}),
  });
  return {
    tunnelId: readNonEmptyString(active, 'tunnelId'),
    state,
    routes: selectors.routes ?? [],
    ...(selectors.domains ? { domains: selectors.domains } : {}),
    ...(selectors.cidrs ? { cidrs: selectors.cidrs } : {}),
    ...(active['binds'] === undefined ? {} : { binds: readBinds(active['binds']) }),
  };
}

function readSelectorText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('tunnel selector must be a string');
  }
  return value;
}

function readBinds(value: unknown): Record<string, DestinationTunnelBindReport[]> {
  const record = readRecord(value, 'tunnel binds');
  const binds: Record<string, DestinationTunnelBindReport[]> = {};
  for (const [selectorId, reports] of Object.entries(record)) {
    if (!Array.isArray(reports)) {
      throw new Error('tunnel bind reports must be an array');
    }
    binds[selectorId] = reports.map((report) => {
      const bind = readRecord(report, 'tunnel bind report');
      const status = readString(bind, 'status');
      if (status !== 'ok' && status !== 'conflict' && status !== 'error') {
        throw new Error(`invalid tunnel bind status ${status}`);
      }
      const osCode = bind['osCode'];
      if (osCode !== undefined && typeof osCode !== 'string') {
        throw new Error('tunnel bind osCode must be a string');
      }
      return {
        address: readNonEmptyString(bind, 'address'),
        status,
        ...(osCode === undefined ? {} : { osCode }),
      };
    });
  }
  return binds;
}

function readTunnelRoute(value: unknown): DestinationTunnelRoute {
  const route = readRecord(value, 'tunnel route');
  const port = route['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('tunnel route port must be an integer from 1 to 65535');
  }
  return {
    host: readNonEmptyString(route, 'host'),
    port,
  };
}

function readTunnelFailure(value: unknown): NonNullable<DestinationTunnelStatus['lastFailure']> {
  const failure = readRecord(value, 'tunnel failure');
  return {
    tunnelId: readNonEmptyString(failure, 'tunnelId'),
    code: readNonEmptyString(failure, 'code'),
  };
}

function readTunnelDialFailure(value: unknown): NonNullable<DestinationTunnelStatus['lastDialFailure']> {
  const failure = readRecord(value, 'tunnel dial failure');
  const connectionId = failure['connectionId'];
  if (
    typeof connectionId !== 'number' ||
    !Number.isInteger(connectionId) ||
    connectionId < 0 ||
    connectionId > 0xffff_ffff
  ) {
    throw new Error('tunnel dial failure connectionId must be an unsigned 32-bit integer');
  }
  const osCode = failure['osCode'];
  if (osCode !== undefined && typeof osCode !== 'string') {
    throw new Error('tunnel dial failure osCode must be a string');
  }
  return {
    tunnelId: readNonEmptyString(failure, 'tunnelId'),
    connectionId,
    routeId: readNonEmptyString(failure, 'routeId'),
    reason: readNonEmptyString(failure, 'reason'),
    ...(osCode === undefined ? {} : { osCode }),
  };
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (value.length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  return value;
}
