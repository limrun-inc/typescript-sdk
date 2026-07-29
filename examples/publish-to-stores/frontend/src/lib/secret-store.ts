// The example's own SigningSecretStore implementation, the pluggable piece
// of the wizard. Both packages declare the interface identically, so this
// one store serves the Apple material and the Android upload keystore
// alike; the type is imported from `@limrun/apple-auth` only for brevity.
import type { SigningSecret, SigningSecretMetadata, SigningSecretStore } from '@limrun/apple-auth';
import { BACKEND_URL } from '../config';
import { failedResponse, withSecretsDir } from './backend';

/**
 * A SigningSecretStore backed by the example backend's file store. This is
 * the "bring your own store" demonstration: the `@limrun/apple-auth` and
 * `@limrun/play-auth` helpers only see the interface, so swapping this for
 * Limrun's org store (`createLimrunSecretStore`) or your own database is a
 * drop-in change.
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
