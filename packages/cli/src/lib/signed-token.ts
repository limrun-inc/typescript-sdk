/** The prefix on access tokens the Limrun API mints. Tokens from the token service have none. */
export const SIGNED_TOKEN_PREFIX = 'lim_st_';

function payloadOf(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ?
        (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The JWT inside a Limrun access token, or undefined for any other credential. A token
 * carries the lim_st_ prefix, or is a bare JWT whose issuer is limrun, as the token service
 * mints them. Nothing is verified.
 */
export function accessTokenJWT(token: string): string | undefined {
  if (token.startsWith(SIGNED_TOKEN_PREFIX)) return token.slice(SIGNED_TOKEN_PREFIX.length);
  return payloadOf(token)?.['iss'] === 'limrun' ? token : undefined;
}

/**
 * The claims of a Limrun access token, read without verifying it; undefined for opaque
 * credentials and malformed tokens. Use them only for local decisions: servers verify.
 */
export function signedTokenClaims(token: string): Record<string, unknown> | undefined {
  const jwt = accessTokenJWT(token);
  return jwt === undefined ? undefined : payloadOf(jwt);
}
