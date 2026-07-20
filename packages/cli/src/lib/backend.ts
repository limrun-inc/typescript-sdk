import Limrun, { APIError, AuthenticationError, NotFoundError } from '@limrun/api';

/**
 * Backend API endpoints the generated resources do not cover (Stainless
 * consumes the director spec only). Rides the SDK client's transport, so
 * auth headers, retries and the 401 -> AuthenticationError mapping that
 * withAuth's re-login relies on all come for free.
 */

export type SecretData = Record<string, string>;

export type PutSecretResult = {
  data: SecretData;
  /** True when this call created the secret, false on a get-or-create hit. */
  created: boolean;
};

export const androidSigningKeySecretType = 'androidSigningKey';

/** Wraps transport errors with call context; auth errors pass through untouched. */
function rethrow(err: unknown, context: string): never {
  if (err instanceof AuthenticationError || !(err instanceof APIError)) {
    throw err;
  }
  throw new Error(`${context}: ${err.message}`);
}

/**
 * Resolves the organization the API key acts for. `lim login` keys are
 * organization tokens, so `organization` is the normal path; hand-set
 * user API keys fall back to the user's default organization, which
 * /v1/whoami nests inside `user`.
 */
export async function whoAmI(client: Limrun): Promise<string> {
  let body: { organization?: { id?: string }; user?: { defaultOrganization?: { id?: string } } };
  try {
    body = await client.get('/v1/whoami');
  } catch (err) {
    rethrow(err, 'Failed to resolve the organization');
  }
  const organizationId = body.organization?.id ?? body.user?.defaultOrganization?.id;
  if (!organizationId) {
    throw new Error('The Limrun API did not report an organization for this API key.');
  }
  return organizationId;
}

function secretPath(organizationId: string, secretType: string, secretName: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/secrets/${encodeURIComponent(
    secretType,
  )}/${encodeURIComponent(secretName)}`;
}

/** Fetches a secret's data, or undefined when it does not exist. */
export async function getSecret(
  client: Limrun,
  organizationId: string,
  secretType: string,
  secretName: string,
): Promise<SecretData | undefined> {
  let body: { data?: SecretData };
  try {
    body = await client.get(secretPath(organizationId, secretType, secretName));
  } catch (err) {
    if (err instanceof NotFoundError) {
      return undefined;
    }
    rethrow(err, `Failed to fetch the ${secretType} secret ${secretName}`);
  }
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
  client: Limrun,
  organizationId: string,
  secretType: string,
  secretName: string,
  data: SecretData,
): Promise<PutSecretResult> {
  let body: { data?: SecretData; created?: boolean };
  let response: Response;
  try {
    ({ data: body, response } = await client
      .put<{ data?: SecretData; created?: boolean }>(secretPath(organizationId, secretType, secretName), {
        body: { data },
      })
      .withResponse());
  } catch (err) {
    rethrow(err, `Failed to store the ${secretType} secret ${secretName}`);
  }
  if (!body.data) {
    throw new Error(`The Limrun API returned a ${secretType} secret without data.`);
  }
  return { data: body.data, created: body.created ?? response.status === 201 };
}
