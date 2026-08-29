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
  const tunnelPath = `${url.pathname.replace(/\/+$/, '')}/tunnel`;
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
