// The frontend's channel to the example backend: the registry session, the
// file-based secret store, and the publish endpoints. (The Apple relay
// WebSocket itself goes straight to Limrun's registry, authenticated with
// the scoped token from the session.)
import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/apple-auth';
import { BACKEND_URL } from '../config';

export type RegistrySession = {
  /** Short-lived scoped token; only good for opening the Apple relay. */
  token: string;
  /** Limrun registry base URL the browser connects to directly. */
  registryUrl: string;
  expiresAt: string;
  /** The backend's default secrets directory; the UI's field defaults to it. */
  secretsDir?: string;
};

// The secrets directory on the backend host, chosen in the UI and persisted
// here. Empty means the backend's own default. It is read at request time,
// so every store operation and publish uses the latest choice.
const SECRETS_DIR_STORAGE_KEY = 'publish-to-stores.secretsDir';

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
// and persisted here. It rides every publish request; the backend passes it
// to the lim CLI verbatim.
const WEBHOOK_URL_STORAGE_KEY = 'publish-to-stores.webhookUrl';

export function getWebhookUrl(): string {
  return localStorage.getItem(WEBHOOK_URL_STORAGE_KEY) ?? '';
}

export function setWebhookUrl(url: string) {
  if (url.trim()) localStorage.setItem(WEBHOOK_URL_STORAGE_KEY, url);
  else localStorage.removeItem(WEBHOOK_URL_STORAGE_KEY);
}

/**
 * Asks the backend for a scoped registry token. The Limrun API key stays on
 * the backend; the browser only ever holds this token, which is confined to
 * the Apple relay and expires on its own.
 */
export async function fetchRegistrySession(): Promise<RegistrySession> {
  const response = await fetch(`${BACKEND_URL}/session`, { method: 'POST' });
  if (!response.ok) await failedResponse(response, 'Failed to start a registry session');
  return (await response.json()) as RegistrySession;
}

/**
 * A SigningSecretStore backed by the example backend's file store. This is
 * the "bring your own store" demonstration: the `@limrun/apple-auth` credential
 * helpers only see the interface, so swapping this for Limrun's org store
 * (`createLimrunSecretStore`) or your own database is a drop-in change.
 */
export function createBackendSecretStore(): SigningSecretStore {
  // Secret names contain slashes (e.g. TEAMID/DISTRIBUTION), so the name
  // travels as a single URI-encoded path segment.
  const secretUrl = (type: string, name: string) =>
    withSecretsDir(`${BACKEND_URL}/secrets/${encodeURIComponent(type)}/${encodeURIComponent(name)}`);

  return {
    async put(type, name, data) {
      const response = await fetch(secretUrl(type, name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!response.ok) await failedResponse(response, 'Failed to store secret');
      return (await response.json()) as SigningSecret;
    },
    async get(type, name) {
      const response = await fetch(secretUrl(type, name));
      if (response.status === 404) return undefined;
      if (!response.ok) await failedResponse(response, 'Failed to fetch secret');
      return (await response.json()) as SigningSecret;
    },
    async list() {
      const response = await fetch(withSecretsDir(`${BACKEND_URL}/secrets`));
      if (!response.ok) await failedResponse(response, 'Failed to list secrets');
      return (await response.json()) as SigningSecretMetadata[];
    },
    async delete(type, name) {
      const response = await fetch(secretUrl(type, name), { method: 'DELETE' });
      if (response.status === 404) return;
      if (!response.ok) await failedResponse(response, 'Failed to delete secret');
    },
  };
}

export type PublishInput = {
  projectPath: string;
  teamId: string;
  bundleId: string;
  scheme?: string;
  /** Public URL limbuild POSTs the build-finish webhook to, verbatim. */
  webhookUrl: string;
};

/**
 * The build-finish webhook payload limbuild POSTs to the backend once the
 * build reaches a terminal state. The UI shows the raw JSON; these fields
 * are the ones it also reads directly.
 */
export type BuildWebhookPayload = {
  execId?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  buildDurationMs?: number;
  error?: string;
  instanceId?: string;
  /** Instance debug page in the Limrun Console. */
  consoleUrl?: string;
  /** Presigned, time-limited URL for the persisted build log. */
  logsUrl?: string;
  bundleIdentifier?: string;
  shortVersion?: string;
  buildVersion?: string;
};

export type PublishStatus = {
  id: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  /** Console page of the build instance, known while the build still runs. */
  consoleUrl?: string;
  webhook?: BuildWebhookPayload;
  webhookReceivedAt?: string;
  error?: string;
};

async function failedResponse(response: Response, action: string): Promise<never> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Non-JSON error body; the status code is the best we have.
  }
  throw new Error(`${action}: ${message}`);
}

export type AndroidPublishInput = {
  projectPath: string;
  packageName: string;
  /** Browser-minted Google OAuth token; rides this one request only. */
  googleAccessToken: string;
  track?: string;
  /** Public URL limbuild POSTs the build-finish webhook to, verbatim. */
  webhookUrl: string;
};

/**
 * Starts a publish and returns its ID. The build runs server-side; its
 * outcome arrives at the backend as a build-finish webhook, which the
 * frontend observes by polling fetchPublishStatus.
 */
export async function startPublish(input: PublishInput): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The build reads the signing secrets server-side, so it must look in
    // the same directory the store operations used.
    body: JSON.stringify({ ...input, secretsDir: getSecretsDir().trim() || undefined }),
  });
  if (!response.ok) await failedResponse(response, 'Publish request failed');
  const body = (await response.json()) as { publishId: string };
  return body.publishId;
}

export async function fetchPublishStatus(publishId: string): Promise<PublishStatus> {
  const response = await fetch(`${BACKEND_URL}/publish/${encodeURIComponent(publishId)}`);
  if (!response.ok) await failedResponse(response, 'Publish status check failed');
  return (await response.json()) as PublishStatus;
}

/** Asks the backend to detect the Android application ID from the project. */
export async function detectAndroidPackage(projectPath: string): Promise<string | undefined> {
  const response = await fetch(`${BACKEND_URL}/project/android-package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath }),
  });
  if (!response.ok) await failedResponse(response, 'Could not inspect the project');
  const body = (await response.json()) as { packageName?: string | null };
  return body.packageName ?? undefined;
}

/** Starts a detached Android publish and returns the ID used for status polling. */
export async function startAndroidPublish(input: AndroidPublishInput): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/publish/android`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, secretsDir: getSecretsDir().trim() || undefined }),
  });
  if (!response.ok) await failedResponse(response, 'Publish request failed');
  const body = (await response.json()) as { publishId: string };
  return body.publishId;
}
