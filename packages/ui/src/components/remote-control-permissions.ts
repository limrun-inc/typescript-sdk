/** Infers UI restrictions only. The server verifies the token and enforces its grants. */
export function tokenRequiresWatchOnly(url: string, token: string): boolean {
  if (!token.startsWith('lim_st_')) return false;
  try {
    const instanceId = new URL(url).pathname
      .split('/')
      .map(decodeURIComponent)
      .find((part) => /^(ios|android)_[a-z0-9_]+$/.test(part));
    if (!instanceId) return false;
    const resource = instanceId.split('_')[0];
    const parts = token.slice('lim_st_'.length).split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return false;
    const payload = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(payload, (char) => char.charCodeAt(0))),
    );
    if (!claims || typeof claims !== 'object' || !('scopes' in claims)) return false;
    const scopes = claims.scopes;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return false;

    let canWatch = false;
    for (const scope of scopes) {
      const [scopeResource, scopeId, action, extra] = scope.split(':');
      if (extra !== undefined || (scopeResource !== resource && scopeResource !== '*')) continue;
      if (scopeId !== instanceId && scopeId !== '*') continue;
      if (action === 'stream' || action === 'all') return false;
      if (action === 'watch') canWatch = true;
    }
    return canWatch;
  } catch {
    // Opaque credentials and unrecognized URLs retain the explicit prop's behavior.
    return false;
  }
}
