import { deriveAdbHttpURL } from './destination-tunnel-url';
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
export function addTrustedCaCertificate(
  adbUrl: string,
  token: string,
  pem: string,
): Promise<TrustedCaCertificate> {
  return postTrustedCaCertificate(deriveAdbHttpURL(adbUrl, 'trusted-cas').toString(), token, pem);
}

/**
 * Posts a PEM CA certificate to an instance's `trusted-cas` endpoint. Both
 * platforms serve one; limulator answers errors as JSON, websocket-proxy as text.
 */
export async function postTrustedCaCertificate<T>(
  url: string,
  token: string,
  pem: string,
  missingReason?: string,
): Promise<T> {
  const response = await nodeProxyTransport.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-pem-file', Authorization: `Bearer ${token}` },
    body: pem,
  });
  if (!response.ok) {
    const text = (await response.text()).trim();
    let reason = text;
    try {
      reason = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // Plain text already.
    }
    if (response.status === 404 && missingReason) {
      reason = missingReason;
    }
    throw new Error(`Adding the CA certificate failed (${response.status}): ${reason}`);
  }
  return (await response.json()) as T;
}
