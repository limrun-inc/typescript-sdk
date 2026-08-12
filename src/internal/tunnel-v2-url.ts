export function deriveTunnelV2URL(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error(`Unsupported apiUrl protocol for tunnel: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/tunnel`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
