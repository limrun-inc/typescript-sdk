/** The endpoint at `path` under a base URL, without query or fragment. */
function deriveEndpointURL(apiUrl: string, path: string): URL {
  const url = new URL(apiUrl);
  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:' &&
    url.protocol !== 'wss:' &&
    url.protocol !== 'ws:'
  ) {
    throw new Error(`Unsupported apiUrl protocol: ${url.protocol}`);
  }
  url.pathname = `${withoutTrailingSlashes(url.pathname)}/${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

/** The HTTP endpoint at `path` under an instance's ADB WebSocket URL. */
export function deriveAdbHttpURL(adbUrl: string, path: string): URL {
  const url = deriveEndpointURL(adbUrl, path);
  url.protocol =
    url.protocol === 'wss:' ? 'https:'
    : url.protocol === 'ws:' ? 'http:'
    : url.protocol;
  return url;
}

export function deriveDestinationTunnelURL(apiUrl: string): string {
  return webSocketURL(deriveEndpointURL(apiUrl, 'tunnel'));
}

/** The control WebSocket of a persistent tunnel, under the Limrun API base URL. */
export function deriveTunnelConnectURL(baseURL: string, organizationId: string, name: string): string {
  return webSocketURL(
    deriveEndpointURL(
      baseURL,
      `v1/organizations/${encodeURIComponent(organizationId)}/tunnels/${encodeURIComponent(name)}/connect`,
    ),
  );
}

function webSocketURL(url: URL): string {
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function deriveDestinationTunnelStatusURL(apiUrl: string): URL {
  return deriveAdbHttpURL(apiUrl, 'tunnel/status');
}

export function deriveDestinationTunnelStopURL(apiUrl: string, tunnelId: string): URL {
  return deriveAdbHttpURL(apiUrl, `tunnel/${encodeURIComponent(tunnelId)}`);
}

export function deriveDestinationTunnelInspectionURL(
  tunnelUrl: string,
  tunnelId: string,
  token: string,
): string;
export function deriveDestinationTunnelInspectionURL(
  tunnelUrl: string,
  tunnelId: string,
  afterSequence?: number,
  token?: string,
): string;
export function deriveDestinationTunnelInspectionURL(
  tunnelUrl: string,
  tunnelId: string,
  afterSequenceOrToken: number | string = 0,
  explicitToken?: string,
): string {
  const afterSequence = typeof afterSequenceOrToken === 'number' ? afterSequenceOrToken : 0;
  const token = typeof afterSequenceOrToken === 'string' ? afterSequenceOrToken : explicitToken;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('afterSequence must be a safe non-negative integer');
  }
  const url = new URL(tunnelUrl);
  url.protocol =
    url.protocol === 'wss:' ? 'https:'
    : url.protocol === 'ws:' ? 'http:'
    : url.protocol;
  url.pathname = `${withoutTrailingSlashes(url.pathname)}/${encodeURIComponent(tunnelId)}/inspection/events`;
  url.search = '';
  if (afterSequence > 0) url.searchParams.set('after-sequence', String(afterSequence));
  if (token !== undefined) url.searchParams.set('token', token);
  url.hash = '';
  return url.toString();
}

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}
