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
  const body = await fetchWhoAmI(client);
  const organizationId = body.organization?.id ?? body.user?.defaultOrganization?.id;
  if (!organizationId) {
    throw new Error('The Limrun API did not report an organization for this API key.');
  }
  return organizationId;
}

interface WhoAmIBody {
  organization?: { id?: string };
  user?: { defaultOrganization?: { id?: string } };
}

async function fetchWhoAmI(client: Limrun): Promise<WhoAmIBody> {
  try {
    return await client.get('/v1/whoami');
  } catch (err) {
    rethrow(err, 'Failed to resolve the organization');
  }
}

/** A persistent tunnel as the backend lists it. */
export interface PersistentTunnel {
  id: string;
  name: string;
  ephemeral: boolean;
  online: boolean;
  selectors: string[];
  hostname?: string;
  tokenExpiresAt?: string;
  instances: { id: string; platform: string; state: string }[];
}

/** A tunnel token as the backend returns it, once: Limrun never stores it. */
export interface TunnelToken {
  token: string;
  expiresAt: string;
}

/**
 * Resolves the organization a credential manages tunnels for. It must be an
 * organization key or login, so a user token's default organization does not
 * count. A tunnel token belongs in `lim tunnel run --token`: the backend
 * accepts no signed token.
 */
export async function tunnelOrganization(client: Limrun): Promise<string> {
  if ((client.apiKey ?? '').startsWith(SIGNED_TOKEN_PREFIX)) {
    throw new Error(
      'The API key is a signed token. Pass a tunnel token to lim tunnel run with --token or ' +
        'LIM_TUNNEL_TOKEN; managing tunnels needs an organization API key or login.',
    );
  }
  const body = await fetchWhoAmI(client);
  const organizationId = body.organization?.id;
  if (!organizationId) {
    throw new Error('Managing tunnels needs an organization API key or login.');
  }
  return organizationId;
}

/** The tunnel a credential's scopes name, when its only scope connects one. */
function onlyTunnelOf(scopes: unknown): string | undefined {
  const [scope, ...rest] = Array.isArray(scopes) ? scopes : [];
  const match =
    rest.length === 0 && typeof scope === 'string' ? /^tunnel:(tunnel_[0-9a-z]+):connect$/.exec(scope) : null;
  return match?.[1];
}

const SIGNED_TOKEN_PREFIX = 'lim_st_';

/**
 * Reads the organization and tunnel a tunnel token names, without verifying
 * it; undefined when the token is no tunnel token. Its only scope is
 * tunnel:<id>:connect.
 */
export function tunnelTokenClaims(token: string): { organizationId: string; tunnelId: string } | undefined {
  const payload = token.slice(SIGNED_TOKEN_PREFIX.length).split('.')[1];
  if (!token.startsWith(SIGNED_TOKEN_PREFIX) || !payload) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof claims !== 'object' || claims === null) {
    return undefined;
  }
  const { sub, scopes } = claims as { sub?: unknown; scopes?: unknown };
  const tunnelId = onlyTunnelOf(scopes);
  if (!tunnelId || typeof sub !== 'string' || sub === '') {
    return undefined;
  }
  return { organizationId: sub, tunnelId };
}

function tunnelsPath(organizationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/tunnels`;
}

function tunnelPath(organizationId: string, tunnelId: string): string {
  return `${tunnelsPath(organizationId)}/${encodeURIComponent(tunnelId)}`;
}

/** Lists an organization's tunnels. */
export async function listTunnels(client: Limrun, organizationId: string): Promise<PersistentTunnel[]> {
  let body: { tunnels?: PersistentTunnel[] };
  try {
    body = await client.get(tunnelsPath(organizationId));
  } catch (err) {
    rethrow(err, 'Failed to list tunnels');
  }
  return body.tunnels ?? [];
}

/** Finds an organization's tunnel by the name instances use. */
export async function findTunnel(
  client: Limrun,
  organizationId: string,
  name: string,
): Promise<PersistentTunnel | undefined> {
  return (await listTunnels(client, organizationId)).find((tunnel) => tunnel.name === name);
}

/**
 * Creates a tunnel with the token its connector runs with: only tunnel tokens
 * connect. The token is returned only here.
 */
export async function createTunnel(
  client: Limrun,
  organizationId: string,
  request: { name: string; selectors: string[]; expirationMonths: number; ephemeral?: boolean },
): Promise<{ tunnel: PersistentTunnel; token: TunnelToken }> {
  const { name, selectors, expirationMonths, ephemeral } = request;
  let body: { tunnel: PersistentTunnel; token?: TunnelToken };
  try {
    body = await client.post(tunnelsPath(organizationId), {
      body: { name, selectors, ...(ephemeral && { ephemeral }), token: { expirationMonths } },
    });
  } catch (err) {
    rethrow(err, `Failed to create tunnel ${name}`);
  }
  if (!body.token?.token) {
    // Nothing can run a tunnel without its token, so it goes at once.
    await deleteTunnel(client, organizationId, body.tunnel.id).catch(() => {});
    throw new Error(`Limrun created tunnel ${name} but returned no token to run it with.`);
  }
  return { tunnel: body.tunnel, token: body.token };
}

/**
 * Creates a quick tunnel that goes away when its connector does. Its token
 * goes with the tunnel, so it lasts a month, the shortest the API takes.
 */
export async function createQuickTunnel(
  client: Limrun,
  organizationId: string,
  name: string,
  selectors: string[],
): Promise<{ tunnel: PersistentTunnel; token: string }> {
  const created = await createTunnel(client, organizationId, {
    name,
    selectors,
    expirationMonths: 1,
    ephemeral: true,
  });
  return { tunnel: created.tunnel, token: created.token.token };
}

/** Replaces a tunnel's selectors. Instances attached after the change get them. */
export async function updateTunnelSelectors(
  client: Limrun,
  organizationId: string,
  tunnel: PersistentTunnel,
  selectors: string[],
): Promise<PersistentTunnel> {
  try {
    return await client.patch(tunnelPath(organizationId, tunnel.id), { body: { selectors } });
  } catch (err) {
    rethrow(err, `Failed to update tunnel ${tunnel.name}`);
  }
}

/** Issues a tunnel's token, which revokes the one it had. */
export async function rotateTunnelToken(
  client: Limrun,
  organizationId: string,
  tunnel: PersistentTunnel,
  expirationMonths: number,
): Promise<TunnelToken> {
  try {
    return await client.post(`${tunnelPath(organizationId, tunnel.id)}/token`, {
      body: { expirationMonths },
    });
  } catch (err) {
    rethrow(err, `Failed to rotate the token of tunnel ${tunnel.name}`);
  }
}

/**
 * Deletes a tunnel, which revokes its token. A tunnel already gone is fine:
 * the hub deletes a quick tunnel when its connector says bye.
 */
export async function deleteTunnel(client: Limrun, organizationId: string, tunnelId: string): Promise<void> {
  try {
    await client.delete(tunnelPath(organizationId, tunnelId));
  } catch (err) {
    if (err instanceof NotFoundError) {
      return;
    }
    rethrow(err, `Failed to delete tunnel ${tunnelId}`);
  }
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
