import { nodeProxyTransport } from './proxy-transport';
import { deriveDestinationTunnelStatusURL, deriveDestinationTunnelStopURL } from './destination-tunnel-url';
import { readArray, readNonEmptyString, readRecord, readString } from './destination-tunnel-wire-reader';
import {
  validateDestinationTunnelSelectors,
  normalizeDestinationTunnelInspection,
  type DestinationTunnelRoute,
  type DestinationTunnelBindReport,
  type DestinationTunnelInspectionConfig,
} from '../destination-tunnel';

export interface DestinationTunnelStatus {
  active?: {
    tunnelId: string;
    state: 'starting' | 'ready' | 'stopping';
    routes: DestinationTunnelRoute[];
    domains?: string[];
    /** Per exact route, the device-side bind outcomes (Android bind listeners). */
    binds?: Record<string, DestinationTunnelBindReport[]>;
    inspection: DestinationTunnelInspectionConfig;
  };
  lastFailure?: {
    tunnelId: string;
    code: string;
  };
  lastDialFailure?: {
    tunnelId: string;
    connectionId: number;
    selectorId: string;
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
  const selectors = validateDestinationTunnelSelectors({
    ...(routes.length > 0 ? { routes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  });
  return {
    tunnelId: readNonEmptyString(active, 'tunnelId'),
    state,
    routes: selectors.routes ?? [],
    ...(selectors.domains ? { domains: selectors.domains } : {}),
    ...(active['binds'] === undefined ? {} : { binds: readBinds(active['binds']) }),
    inspection: readInspection(active),
  };
}

function readInspection(active: Record<string, unknown>): DestinationTunnelInspectionConfig {
  const inspection = readRecord(active['inspection'], 'inspection');
  const enabled = inspection['enabled'];
  const captureBodies = inspection['captureBodies'];
  if (typeof enabled !== 'boolean' || typeof captureBodies !== 'boolean') {
    throw new Error('inspection enabled and captureBodies must be booleans');
  }
  const maxBodyBytes = inspection['maxBodyBytes'];
  if (typeof maxBodyBytes !== 'number') {
    throw new Error('inspection maxBodyBytes must be a number');
  }
  return normalizeDestinationTunnelInspection({ enabled, captureBodies, maxBodyBytes });
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
    selectorId: readNonEmptyString(failure, 'selectorId'),
    reason: readNonEmptyString(failure, 'reason'),
    ...(osCode === undefined ? {} : { osCode }),
  };
}
