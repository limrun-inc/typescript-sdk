// The frontend's channel to the example backend: the file-based secret
// store and the publish SSE stream. (The Apple relay WebSocket also rides
// the backend, but `@limrun/ui` opens that connection itself.)
import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/ui/apple';
import { BACKEND_URL } from '../config';

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

export type PublishEvent = {
  event: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
};

export type AndroidPublishInput = {
  projectPath: string;
  packageName: string;
  /** Browser-minted Google OAuth token; rides this one request only. */
  googleAccessToken: string;
  track?: string;
};

/**
 * Posts a publish request and feeds the backend's SSE stream to `onEvent`
 * until the stream ends. EventSource cannot POST, so this parses the SSE
 * frames off a plain fetch body.
 */
export async function streamPublish(input: PublishInput, onEvent: (event: PublishEvent) => void) {
  return postAndStreamSse('/publish', input, onEvent);
}

/** The Play Store counterpart: same SSE contract, different endpoint. */
export async function streamAndroidPublish(
  input: AndroidPublishInput,
  onEvent: (event: PublishEvent) => void,
) {
  return postAndStreamSse('/publish/android', input, onEvent);
}

async function postAndStreamSse(path: string, input: unknown, onEvent: (event: PublishEvent) => void) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body; the status code is the best we have.
    }
    throw new Error(`Publish request failed: ${message}`);
  }
  if (!response.body) {
    throw new Error('Publish request returned no stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      let event = 'stdout';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
        else if (line === 'data:' || line === 'data: ') data.push('');
      }
      onEvent({ event: event as PublishEvent['event'], data: data.join('\n') });
    }
  }
}
