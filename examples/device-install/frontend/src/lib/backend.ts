import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/apple-auth';
import { BACKEND_URL } from '../config';

export type RegistrySession = {
  token: string;
  registryUrl: string;
  expiresAt: string;
};

async function responseError(response: Response, action: string): Promise<never> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Keep the status-code fallback for non-JSON errors.
  }
  throw new Error(`${action}: ${message}`);
}

export async function fetchRegistrySession(): Promise<RegistrySession> {
  const response = await fetch(`${BACKEND_URL}/session`, { method: 'POST' });
  if (!response.ok) await responseError(response, 'Failed to start an Apple relay session');
  return (await response.json()) as RegistrySession;
}

export type DeviceSession = RegistrySession & {
  assetId?: string;
  assetName?: string;
};

export async function fetchDeviceSession(installId?: string): Promise<DeviceSession> {
  const response = await fetch(`${BACKEND_URL}/device-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(installId ? { installId } : {}),
  });
  if (!response.ok) await responseError(response, 'Failed to start a device session');
  return (await response.json()) as DeviceSession;
}

export function createBackendSecretStore(): SigningSecretStore {
  const secretUrl = (type: string, name: string) =>
    `${BACKEND_URL}/secrets/${encodeURIComponent(type)}/${encodeURIComponent(name)}`;
  return {
    async put(type, name, data) {
      const response = await fetch(secretUrl(type, name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!response.ok) await responseError(response, 'Failed to store a signing secret');
      return (await response.json()) as SigningSecret;
    },
    async get(type, name) {
      const response = await fetch(secretUrl(type, name));
      if (response.status === 404) return undefined;
      if (!response.ok) await responseError(response, 'Failed to fetch a signing secret');
      return (await response.json()) as SigningSecret;
    },
    async list() {
      const response = await fetch(`${BACKEND_URL}/secrets`);
      if (!response.ok) await responseError(response, 'Failed to list signing secrets');
      return (await response.json()) as SigningSecretMetadata[];
    },
    async delete(type, name) {
      const response = await fetch(secretUrl(type, name), { method: 'DELETE' });
      if (response.status !== 404 && !response.ok) {
        await responseError(response, 'Failed to delete a signing secret');
      }
    },
  };
}

export type InstallMethod = 'webusb' | 'qr';

export type InstallInput = {
  projectPath: string;
  method: InstallMethod;
  teamId: string;
  bundleId: string;
  deviceUDID: string;
  scheme?: string;
};

export type BuildWebhookPayload = {
  status?: string;
  error?: string;
  buildDurationMs?: number;
  consoleUrl?: string;
  logsUrl?: string;
  bundleIdentifier?: string;
  shortVersion?: string;
  buildVersion?: string;
};

export type InstallStatus = {
  id: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  method: InstallMethod;
  deviceUDID: string;
  assetName: string;
  webhook?: BuildWebhookPayload;
  webhookReceivedAt?: string;
  error?: string;
};

export async function startInstall(input: InstallInput): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) await responseError(response, 'Install build request failed');
  return ((await response.json()) as { installId: string }).installId;
}

export async function fetchInstallStatus(installId: string): Promise<InstallStatus> {
  const response = await fetch(`${BACKEND_URL}/install/${encodeURIComponent(installId)}`);
  if (!response.ok) await responseError(response, 'Install build status check failed');
  return (await response.json()) as InstallStatus;
}
