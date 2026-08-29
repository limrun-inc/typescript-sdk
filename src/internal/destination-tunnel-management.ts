import { nodeProxyTransport } from './proxy-transport';
import { deriveDestinationTunnelStatusURL, deriveDestinationTunnelStopURL } from './destination-tunnel-url';
import { readArray, readNonEmptyString, readRecord, readString } from './destination-tunnel-wire-reader';
import {
  normalizeDestinationTunnelInspection,
  type DestinationTunnelBindReport,
  type DestinationTunnelInspectionConfig,
  type DestinationTunnelSelectorReport,
} from '../destination-tunnel';

export interface DestinationTunnelStatus {
  active?: {
    tunnelId: string;
    state: 'starting' | 'ready' | 'stopping';
    selectors: DestinationTunnelSelectorReport[];
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
  return {
    tunnelId: readNonEmptyString(active, 'tunnelId'),
    state,
    selectors: readArray(active, 'selectors').map(readSelectorReport),
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

function readSelectorReport(value: unknown): DestinationTunnelSelectorReport {
  const report = readRecord(value, 'tunnel selector');
  const kind = readString(report, 'kind');
  if (kind !== 'route' && kind !== 'domain') {
    throw new Error(`invalid tunnel selector kind ${kind}`);
  }
  return {
    id: readNonEmptyString(report, 'id'),
    kind,
    value: readNonEmptyString(report, 'value'),
    ...(report['binds'] === undefined ?
      {}
    : { binds: readArray(report, 'binds').map(readBindReport) }),
  };
}

function readBindReport(value: unknown): DestinationTunnelBindReport {
  const bind = readRecord(value, 'tunnel bind report');
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
