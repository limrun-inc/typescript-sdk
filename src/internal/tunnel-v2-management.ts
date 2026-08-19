import { nodeProxyTransport } from './proxy-transport';
import { deriveTunnelManagementURL } from './tunnel-v2-url';

export interface TunnelV2Status {
  active?: {
    tunnelId: string;
    state: 'starting' | 'ready' | 'stopping';
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

export async function getTunnelV2Status(apiUrl: string, token: string): Promise<TunnelV2Status> {
  const response = await nodeProxyTransport.fetch(deriveTunnelManagementURL(apiUrl).toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`getTunnelStatus failed: ${response.status} ${await response.text()}`);
  }
  return decodeTunnelV2Status(await response.json());
}

export async function stopTunnelV2(apiUrl: string, token: string, tunnelId: string): Promise<void> {
  if (!tunnelId.trim()) {
    throw new Error('tunnelId must not be empty');
  }
  const url = deriveTunnelManagementURL(apiUrl);
  url.searchParams.set('tunnelId', tunnelId);
  const response = await nodeProxyTransport.fetch(url.toString(), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`stopTunnel failed: ${response.status} ${await response.text()}`);
  }
}

export function decodeTunnelV2Status(value: unknown): TunnelV2Status {
  const status = readRecord(value, 'tunnel status');
  const decodedStatus: TunnelV2Status = {};
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

function readActiveTunnel(value: unknown): NonNullable<TunnelV2Status['active']> {
  const active = readRecord(value, 'active tunnel');
  const state = readString(active, 'state');
  if (state !== 'starting' && state !== 'ready' && state !== 'stopping') {
    throw new Error(`invalid tunnel state ${state}`);
  }
  return {
    tunnelId: readNonEmptyString(active, 'tunnelId'),
    state,
  };
}

function readTunnelFailure(value: unknown): NonNullable<TunnelV2Status['lastFailure']> {
  const failure = readRecord(value, 'tunnel failure');
  return {
    tunnelId: readNonEmptyString(failure, 'tunnelId'),
    code: readNonEmptyString(failure, 'code'),
  };
}

function readTunnelDialFailure(value: unknown): NonNullable<TunnelV2Status['lastDialFailure']> {
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
