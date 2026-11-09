import { directInstanceErrorReason } from './direct-instance-errors';
import { deriveAdbHttpURL } from './destination-tunnel-url';
import { nodeProxyTransport } from './proxy-transport';

/** The `blocked-domains` endpoint of an Android instance, served by websocket-proxy on its ADB URL. */
export function androidBlockedDomainsUrl(adbUrl: string): string {
  return deriveAdbHttpURL(adbUrl, 'blocked-domains').toString();
}

/**
 * Reads an instance's blocked domains, or replaces them when `domains` is set.
 * Both platforms serve the same document, `{ "domains": [...] }`, and answer
 * with the list in force in canonical form.
 */
export async function requestBlockedDomains(
  url: string,
  token: string,
  domains?: string[],
): Promise<string[]> {
  const response = await nodeProxyTransport.fetch(url, {
    method: domains ? 'PUT' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(domains ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(domains ? { body: JSON.stringify({ domains }) } : {}),
  });
  if (!response.ok) {
    const reason = directInstanceErrorReason(await response.text());
    throw new Error(
      `${domains ? 'Setting' : 'Reading'} the blocked domains failed (${response.status}): ${
        reason || response.statusText
      }`,
    );
  }
  return ((await response.json()) as { domains: string[] }).domains;
}
