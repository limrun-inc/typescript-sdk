import { nodeProxyTransport } from './proxy-transport';

/** A CA certificate the device now trusts. */
export interface TrustedCaCertificate {
  /** File name in Android's system store: the subject hash plus a suffix. */
  filename: string;
  /** SHA-256 of the certificate's DER encoding, in hex. */
  sha256: string;
}

/**
 * Adds a PEM CA certificate to an Android instance's trust stores
 * through websocket-proxy, which answers on the instance's ADB URL.
 */
export async function addTrustedCaCertificate(
  adbUrl: string,
  token: string,
  pem: string | Buffer,
): Promise<TrustedCaCertificate> {
  const url = new URL(adbUrl);
  url.protocol =
    url.protocol === 'wss:' ? 'https:'
    : url.protocol === 'ws:' ? 'http:'
    : url.protocol;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/trusted-cas`;
  url.search = '';
  url.hash = '';
  const response = await nodeProxyTransport.fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-pem-file', Authorization: `Bearer ${token}` },
    body: typeof pem === 'string' ? pem : pem.toString('utf8'),
  });
  if (!response.ok) {
    const reason = (await response.text()).trim();
    throw new Error(`Adding the CA certificate failed (${response.status}): ${reason}`);
  }
  return (await response.json()) as TrustedCaCertificate;
}
