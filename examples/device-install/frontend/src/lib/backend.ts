import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/apple-auth';
import { BACKEND_URL } from '../config';

/** Renders any thrown value as a user-facing message. */
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export type RegistrySession = {
  token: string;
  registryUrl: string;
  expiresAt: string;
  /** The backend's default secrets directory; the UI's field defaults to it. */
  secretsDir?: string;
};

// The secrets directory on the backend host, chosen in the UI and persisted
// here. Empty means the backend's own default. It is read at request time,
// so every store operation and install build uses the latest choice.
const SECRETS_DIR_STORAGE_KEY = 'device-install.secretsDir';

export function getSecretsDir(): string {
  return localStorage.getItem(SECRETS_DIR_STORAGE_KEY) ?? '';
}

export function setSecretsDir(dir: string) {
  if (dir.trim()) localStorage.setItem(SECRETS_DIR_STORAGE_KEY, dir);
  else localStorage.removeItem(SECRETS_DIR_STORAGE_KEY);
}

/** Appends the chosen secrets directory to a store URL, when one is set. */
function withSecretsDir(url: string) {
  const dir = getSecretsDir().trim();
  return dir ? `${url}${url.includes('?') ? '&' : '?'}dir=${encodeURIComponent(dir)}` : url;
}

// The public URL limbuild POSTs build-finish webhooks to, entered in the UI
// and persisted here. It rides every install build request; the backend
// passes it to the lim CLI verbatim.
const WEBHOOK_URL_STORAGE_KEY = 'device-install.webhookUrl';

export function getWebhookUrl(): string {
  return localStorage.getItem(WEBHOOK_URL_STORAGE_KEY) ?? '';
}

export function setWebhookUrl(url: string) {
  if (url.trim()) localStorage.setItem(WEBHOOK_URL_STORAGE_KEY, url);
  else localStorage.removeItem(WEBHOOK_URL_STORAGE_KEY);
}

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
    withSecretsDir(`${BACKEND_URL}/secrets/${encodeURIComponent(type)}/${encodeURIComponent(name)}`);
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
      const response = await fetch(withSecretsDir(`${BACKEND_URL}/secrets`));
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

export type InstallInput = {
  projectPath: string;
  teamId: string;
  bundleId: string;
  deviceUDID: string;
  scheme?: string;
  /** Public URL limbuild POSTs the build-finish webhook to, verbatim. */
  webhookUrl: string;
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
    // The build reads the signing secrets server-side, so it must look in
    // the same directory the store operations used.
    body: JSON.stringify({ ...input, secretsDir: getSecretsDir().trim() || undefined }),
  });
  if (!response.ok) await responseError(response, 'Install build request failed');
  return ((await response.json()) as { installId: string }).installId;
}

export async function fetchInstallStatus(installId: string): Promise<InstallStatus> {
  const response = await fetch(`${BACKEND_URL}/install/${encodeURIComponent(installId)}`);
  if (!response.ok) await responseError(response, 'Install build status check failed');
  return (await response.json()) as InstallStatus;
}
