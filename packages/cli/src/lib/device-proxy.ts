import { isIPv4 } from 'net';

/** A device system proxy: a host name or IPv4 address and a port. */
export interface ProxyAddress {
  host: string;
  port: number;
}

// Android's proxy setting ignores names with consecutive hyphens, so labels follow its rule.
const DOMAIN_LABEL = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parses `host:port`. The host is a name or an IPv4 address: the iOS proxy tool and Android's proxy
 * setting take no IPv6 literal. A malformed value fails here instead of on the device.
 */
export function parseProxyAddress(value: string): ProxyAddress {
  const separator = value.lastIndexOf(':');
  const portText = value.slice(separator + 1);
  const port = Number(portText);
  if (
    separator > 0 &&
    /^\d{1,5}$/.test(portText) &&
    port >= 1 &&
    port <= 65535 &&
    /^[\x21-\x7e]+$/.test(value)
  ) {
    const host = value.slice(0, separator).toLowerCase();
    const labels = host.split('.');
    const isName =
      host.length <= 253 &&
      labels.every((label) => DOMAIN_LABEL.test(label)) &&
      !/^\d+$/.test(labels[labels.length - 1]!);
    if (isIPv4(host) || isName) {
      return { host, port };
    }
  }
  throw new Error(`Invalid proxy ${value}. Pass it as host:port, for example localhost:3128.`);
}

/** The message for a failed run of the simulator's in-guest proxy tool. */
export function iosProxyToolError(result: { code: number; stderr: string }): string {
  // Images from before the tool answer any unknown spawn with a usage line that does not name it.
  if (result.stderr.includes('spawn supports only') && !result.stderr.includes('limproxy')) {
    return 'This instance does not support lim ios proxy yet. Create a new instance to use it.';
  }
  if (result.stderr.includes('limproxy is unavailable')) {
    return 'lim ios proxy is unavailable on this simulator.';
  }
  return result.stderr.trim() || `limproxy failed with exit code ${result.code}`;
}
