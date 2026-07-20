import { AuthenticationError } from '@limrun/api';

import { responseMessage } from './auth';

/**
 * Minimal client for backend API endpoints the generated SDK does not
 * cover (Stainless consumes the director spec only). Rides the same edge
 * host as the rest of the CLI (`api-endpoint` config).
 */

export type BackendCredentials = {
  apiEndpoint: string;
  apiKey: string;
};

export type SecretData = Record<string, string>;

export type PutSecretResult = {
  data: SecretData;
  /** True when this call created the secret, false on a get-or-create hit. */
  created: boolean;
};

export const androidSigningKeySecretType = 'androidSigningKey';

async function backendFetch(creds: BackendCredentials, path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(path, creds.apiEndpoint), {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new Error(
      `Cannot reach the Limrun API at ${creds.apiEndpoint}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (response.status === 401) {
    // The SDK error class, so withAuth's re-login self-heal covers these
    // calls exactly like every generated-client call.
    throw new AuthenticationError(401, undefined, 'The Limrun API rejected the API key.', response.headers);
  }
  return response;
}

async function parseJSON<T>(response: Response, what: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`The Limrun API returned an unreadable response for ${what} (HTTP ${response.status}).`);
  }
}

/**
 * Resolves the organization the API key acts for. `lim login` keys are
 * organization tokens, so `organization` is the normal path; hand-set
 * user API keys fall back to the user's default organization, which
 * /v1/whoami nests inside `user`.
 */
export async function whoAmI(creds: BackendCredentials): Promise<{ organizationId: string }> {
  const response = await backendFetch(creds, '/v1/whoami');
  if (!response.ok) {
    throw new Error(`Failed to resolve the organization: ${await responseMessage(response)}`);
  }
  const body = await parseJSON<{
    organization?: { id?: string };
    user?: { defaultOrganization?: { id?: string } };
  }>(response, 'whoami');
  const organizationId = body.organization?.id ?? body.user?.defaultOrganization?.id;
  if (!organizationId) {
    throw new Error('The Limrun API did not report an organization for this API key.');
  }
  return { organizationId };
}

function secretPath(organizationId: string, secretType: string, secretName: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/secrets/${encodeURIComponent(
    secretType,
  )}/${encodeURIComponent(secretName)}`;
}

/** Fetches a secret's data, or undefined when it does not exist. */
export async function getSecret(
  creds: BackendCredentials,
  organizationId: string,
  secretType: string,
  secretName: string,
): Promise<SecretData | undefined> {
  const response = await backendFetch(creds, secretPath(organizationId, secretType, secretName));
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch the ${secretType} secret ${secretName}: ${await responseMessage(response)}`,
    );
  }
  const body = await parseJSON<{ data?: SecretData }>(response, 'secret');
  if (!body.data) {
    throw new Error(`The Limrun API returned a ${secretType} secret without data.`);
  }
  return body.data;
}

/**
 * Get-or-create put. The response data is authoritative: on a hit the
 * submitted data was NOT stored and the caller must adopt the returned
 * material instead. Creation is signaled by the response body's
 * `created` today and by HTTP 201 after the status-split hardening;
 * accept both so either server version works.
 */
export async function putSecret(
  creds: BackendCredentials,
  organizationId: string,
  secretType: string,
  secretName: string,
  data: SecretData,
): Promise<PutSecretResult> {
  const response = await backendFetch(creds, secretPath(organizationId, secretType, secretName), {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to store the ${secretType} secret ${secretName}: ${await responseMessage(response)}`,
    );
  }
  const body = await parseJSON<{ data?: SecretData; created?: boolean }>(response, 'secret');
  if (!body.data) {
    throw new Error(`The Limrun API returned a ${secretType} secret without data.`);
  }
  return { data: body.data, created: body.created ?? response.status === 201 };
}
