/** A device system proxy: a host name or IPv4 address and a port. */
export interface ProxyAddress {
  host: string;
  port: number;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

/**
 * Parses `host:port`. The host is a name or an IPv4 address: the iOS proxy tool and Android's proxy
 * setting take no IPv6 literal. Names follow the tunnel's domain rules, so any proxy a tunnel
 * selector reaches is accepted, and a typo fails here instead of on the device.
 */
export function parseProxyAddress(value: string): ProxyAddress {
  const invalid = new Error(`Invalid proxy ${value}. Pass it as host:port, for example localhost:3128.`);
  const separator = value.lastIndexOf(':');
  const host = value.slice(0, Math.max(separator, 0)).toLowerCase();
  const portText = value.slice(separator + 1);
  const port = Number(portText);
  if (separator <= 0 || !/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
    throw invalid;
  }
  const labels = host.split('.');
  const isName =
    host.length <= 253 &&
    labels.every((label) => DOMAIN_LABEL.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1]!);
  if (!IPV4.test(host) && !isName) {
    throw invalid;
  }
  return { host, port };
}

/** The message for a failed run of the simulator's in-guest proxy tool. */
export function iosProxyToolError(result: { code: number; stderr: string }): string {
  // Images from before the tool answer every unknown spawn with this usage line.
  if (result.stderr.includes('spawn supports only')) {
    return 'This instance does not support lim ios proxy yet. Create a new instance to use it.';
  }
  if (result.stderr.includes('limproxy is unavailable')) {
    return 'This simulator has no system proxy to set.';
  }
  return result.stderr.trim() || `limproxy failed with exit code ${result.code}`;
}
