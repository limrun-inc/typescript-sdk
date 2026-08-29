function deriveDestinationTunnelEndpointURL(apiUrl: string, suffix?: string): URL {
  const url = new URL(apiUrl);
  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:' &&
    url.protocol !== 'wss:' &&
    url.protocol !== 'ws:'
  ) {
    throw new Error(`Unsupported apiUrl protocol for tunnel: ${url.protocol}`);
  }
  const tunnelPath = `${withoutTrailingSlashes(url.pathname)}/tunnel`;
  url.pathname = suffix === undefined ? tunnelPath : `${tunnelPath}/${suffix}`;
  url.search = '';
  url.hash = '';
  return url;
}

export function deriveDestinationTunnelURL(apiUrl: string): string {
  const url = deriveDestinationTunnelEndpointURL(apiUrl);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function deriveDestinationTunnelStatusURL(apiUrl: string): URL {
  const url = deriveDestinationTunnelEndpointURL(apiUrl, 'status');
  url.protocol =
    url.protocol === 'wss:' ? 'https:'
    : url.protocol === 'ws:' ? 'http:'
    : url.protocol;
  return url;
}

export function deriveDestinationTunnelStopURL(apiUrl: string, tunnelId: string): URL {
  const url = deriveDestinationTunnelEndpointURL(apiUrl, encodeURIComponent(tunnelId));
  url.protocol =
    url.protocol === 'wss:' ? 'https:'
    : url.protocol === 'ws:' ? 'http:'
    : url.protocol;
  return url;
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
