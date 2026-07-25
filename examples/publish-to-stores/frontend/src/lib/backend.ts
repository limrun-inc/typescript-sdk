// The frontend's channel to the example backend: the registry session, the
// file-based secret store, and the publish endpoints. (The Apple relay
// WebSocket itself goes straight to Limrun's registry, authenticated with
// the scoped token from the session.)
import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/ui/apple';
import { BACKEND_URL } from '../config';

export type RegistrySession = {
  /** Short-lived scoped token; only good for opening the Apple relay. */
  token: string;
  /** Limrun registry base URL the browser connects to directly. */
  registryUrl: string;
  expiresAt: string;
};

/**
 * Asks the backend for a scoped registry token. The Limrun API key stays on
 * the backend; the browser only ever holds this token, which is confined to
 * the Apple relay and expires on its own.
 */
export async function fetchRegistrySession(): Promise<RegistrySession> {
  const response = await fetch(`${BACKEND_URL}/session`, { method: 'POST' });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status code is the best we have.
    }
    throw new Error(`Failed to start a registry session: ${message}`);
  }
  return (await response.json()) as RegistrySession;
}

/**
 * A SigningSecretStore backed by the example backend's file store. This is
 * the "bring your own store" demonstration: the `@limrun/ui` credential
 * helpers only see the interface, so swapping this for Limrun's org store
 * (`createLimrunSecretStore`) or your own database is a drop-in change.
 */
export function createBackendSecretStore(): SigningSecretStore {
  // Secret names contain slashes (e.g. TEAMID/DISTRIBUTION), so the name
  // travels as a single URI-encoded path segment.
  const secretUrl = (type: string, name: string) =>
    `${BACKEND_URL}/secrets/${encodeURIComponent(type)}/${encodeURIComponent(name)}`;

  async function fail(response: Response, action: string): Promise<never> {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status code is the best we have.
    }
    throw new Error(`Failed to ${action} secret: ${message}`);
  }

  return {
    async put(type, name, data) {
      const response = await fetch(secretUrl(type, name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!response.ok) await fail(response, 'store');
      return (await response.json()) as SigningSecret;
    },
    async get(type, name) {
      const response = await fetch(secretUrl(type, name));
      if (response.status === 404) return undefined;
      if (!response.ok) await fail(response, 'fetch');
      return (await response.json()) as SigningSecret;
    },
    async list() {
      const response = await fetch(`${BACKEND_URL}/secrets`);
      if (!response.ok) await fail(response, 'list');
      return (await response.json()) as SigningSecretMetadata[];
    },
    async delete(type, name) {
      const response = await fetch(secretUrl(type, name), { method: 'DELETE' });
      if (response.status === 404) return;
      if (!response.ok) await fail(response, 'delete');
    },
  };
}

export type PublishMethod = 'testflight' | 'appstore';

export type PublishInput = {
  projectPath: string;
  method: PublishMethod;
  teamId: string;
  bundleId: string;
  scheme?: string;
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
};

export type PublishStatus = {
  id: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
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

/**
 * Starts a publish and returns its ID. The build runs server-side; its
 * outcome arrives at the backend as a build-finish webhook, which the
 * frontend observes by polling fetchPublishStatus.
 */
export async function startPublish(input: PublishInput): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
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
