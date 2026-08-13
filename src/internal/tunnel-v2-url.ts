function deriveTunnelEndpointURL(apiUrl: string, endpoint: 'tunnel-v2' | 'tunnel'): URL {
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported apiUrl protocol for tunnel: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
  url.search = '';
  url.hash = '';
  return url;
}

export function deriveTunnelV2URL(apiUrl: string): string {
  const url = deriveTunnelEndpointURL(apiUrl, 'tunnel-v2');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function deriveTunnelManagementURL(apiUrl: string): URL {
  return deriveTunnelEndpointURL(apiUrl, 'tunnel');
}
