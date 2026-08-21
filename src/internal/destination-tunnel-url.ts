function deriveDestinationTunnelEndpointURL(apiUrl: string, suffix?: string): URL {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
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
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function deriveDestinationTunnelStatusURL(apiUrl: string): URL {
  return deriveDestinationTunnelEndpointURL(apiUrl, 'status');
}

export function deriveDestinationTunnelStopURL(apiUrl: string, tunnelId: string): URL {
  return deriveDestinationTunnelEndpointURL(apiUrl, encodeURIComponent(tunnelId));
}
