/**
 * Minimal client for backend API endpoints the generated SDK does not
 * cover (Stainless consumes the director spec only). Rides the same edge
 * host as the rest of the CLI (`api-endpoint` config).
 */

export type SecretData = Record<string, string>;

export type PutSecretResult = {
  data: SecretData;
  /** True when this call created the secret (HTTP 201), false on a get-or-create hit. */
  created: boolean;
};

export const androidSigningKeySecretType = 'androidSigningKey';

async function backendFetch(
  apiEndpoint: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(path, apiEndpoint), {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new Error(
      `Cannot reach the Limrun API at ${apiEndpoint}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('The Limrun API rejected the API key. Run `lim login` to authenticate.');
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

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) {
      return body.message;
    }
  } catch {
    // fall through to the status line
  }
  return `HTTP ${response.status}`;
}

/**
 * Resolves the organization the API key acts for. `lim login` keys are
 * organization tokens, so `organization` is the normal path; hand-set
 * user API keys fall back to the user's default organization.
 */
export async function whoAmI(apiEndpoint: string, apiKey: string): Promise<{ organizationId: string }> {
  const response = await backendFetch(apiEndpoint, apiKey, '/v1/whoami');
  if (!response.ok) {
    throw new Error(`Failed to resolve the organization: ${await errorMessage(response)}`);
  }
  const body = await parseJSON<{
    organization?: { id?: string };
    defaultOrganization?: { id?: string };
  }>(response, 'whoami');
  const organizationId = body.organization?.id ?? body.defaultOrganization?.id;
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
  apiEndpoint: string,
  apiKey: string,
  organizationId: string,
  secretType: string,
  secretName: string,
): Promise<SecretData | undefined> {
  const response = await backendFetch(
    apiEndpoint,
    apiKey,
    secretPath(organizationId, secretType, secretName),
  );
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch the ${secretType} secret ${secretName}: ${await errorMessage(response)}`,
    );
  }
  const body = await parseJSON<{ data?: SecretData }>(response, 'secret');
  if (!body.data) {
    throw new Error(`The Limrun API returned a ${secretType} secret without data.`);
  }
  return body.data;
}

/**
 * Get-or-create put. The response data is authoritative: on a hit (HTTP
 * 200) the submitted data was NOT stored and the caller must adopt the
 * returned material instead.
 */
export async function putSecret(
  apiEndpoint: string,
  apiKey: string,
  organizationId: string,
  secretType: string,
  secretName: string,
  data: SecretData,
): Promise<PutSecretResult> {
  const response = await backendFetch(
    apiEndpoint,
    apiKey,
    secretPath(organizationId, secretType, secretName),
    {
      method: 'PUT',
      body: JSON.stringify({ data }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to store the ${secretType} secret ${secretName}: ${await errorMessage(response)}`,
    );
  }
  const body = await parseJSON<{ data?: SecretData }>(response, 'secret');
  if (!body.data) {
    throw new Error(`The Limrun API returned a ${secretType} secret without data.`);
  }
  return { data: body.data, created: response.status === 201 };
}
