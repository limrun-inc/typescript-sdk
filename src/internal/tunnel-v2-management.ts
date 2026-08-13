import type { TunnelV2Binding } from '../tunnel-v2';
import { nodeProxyTransport } from './proxy-transport';
import { deriveTunnelManagementURL } from './tunnel-v2-url';

export interface TunnelV2Status {
  active?: {
    tunnelId: string;
    state: 'starting' | 'ready' | 'stopping';
    bindings: TunnelV2Binding[];
  };
  lastFailure?: {
    tunnelId: string;
    code: string;
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
  return decodedStatus;
}

function readActiveTunnel(value: unknown): NonNullable<TunnelV2Status['active']> {
  const active = readRecord(value, 'active tunnel');
  const state = readString(active, 'state');
  if (state !== 'starting' && state !== 'ready' && state !== 'stopping') {
    throw new Error(`invalid tunnel state ${state}`);
  }
  const bindings = active['bindings'];
  if (!Array.isArray(bindings)) {
    throw new Error('tunnel bindings must be an array');
  }
  return {
    tunnelId: readNonEmptyString(active, 'tunnelId'),
    state,
    bindings: bindings.map(readBinding),
  };
}

function readBinding(value: unknown): TunnelV2Binding {
  const binding = readRecord(value, 'tunnel binding');
  return {
    routeId: readNonEmptyString(binding, 'routeId'),
    route: readHostPort(binding['route'], 'tunnel route'),
    endpoint: readHostPort(binding['endpoint'], 'tunnel endpoint'),
  };
}

function readTunnelFailure(value: unknown): NonNullable<TunnelV2Status['lastFailure']> {
  const failure = readRecord(value, 'tunnel failure');
  return {
    tunnelId: readNonEmptyString(failure, 'tunnelId'),
    code: readNonEmptyString(failure, 'code'),
  };
}

function readHostPort(value: unknown, name: string): { host: string; port: number } {
  const hostPort = readRecord(value, name);
  const port = hostPort['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} port must be an integer between 1 and 65535`);
  }
  return {
    host: readNonEmptyString(hostPort, 'host'),
    port,
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
