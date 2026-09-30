import { Flags } from '@oclif/core';
import fs from 'fs';
import path from 'path';

/**
 * Carries --upstream-proxy to the detached tunnel process. The URL may hold
 * credentials, and command-line arguments are visible to other local users.
 */
export const UPSTREAM_PROXY_ENV = 'LIM_TUNNEL_UPSTREAM_PROXY';

/** System and upstream proxy flags shared by `android tunnel` and `ios tunnel`. */
export const tunnelProxyFlags = {
  'system-proxy': Flags.boolean({
    description:
      "Point the device's system proxy at this tunnel while it runs, so every app that honors the " +
      'system proxy sends its HTTP and HTTPS traffic through this machine. --selector becomes optional.',
    default: false,
  }),
  'upstream-proxy': Flags.string({
    description:
      "Send the tunnel's outbound connections to domains and system-proxy destinations through this " +
      'HTTP or HTTPS proxy, e.g. http://recorder.internal:8080. Other lim traffic is unaffected.',
    env: UPSTREAM_PROXY_ENV,
  }),
  'upstream-proxy-ca': Flags.string({
    description:
      'PEM file with a CA to trust for TLS through --upstream-proxy, such as the CA a recording proxy ' +
      're-signs traffic with.',
    dependsOn: ['upstream-proxy'],
  }),
};

export type TunnelProxyFlags = {
  'system-proxy': boolean;
  'upstream-proxy'?: string;
  'upstream-proxy-ca'?: string;
};

export type TunnelProxyContext = {
  /** Point the device's system proxy at the tunnel. */
  systemProxy: boolean;
  /** Proxy for tunnel egress; `ca` holds the PEM text. */
  upstreamProxy?: { url: string; ca?: string };
  /** Absolute --upstream-proxy-ca path, replayed to the detached process. */
  upstreamProxyCaPath?: string;
};

/**
 * Validates the proxy flags against the rest of the command. The system proxy
 * needs inspection, because the instance reads each proxy request to learn
 * its destination.
 */
export function tunnelProxyContext(flags: TunnelProxyFlags, inspect: boolean): TunnelProxyContext {
  if (flags['system-proxy'] && !inspect) {
    throw new Error('--system-proxy cannot be combined with --no-inspect.');
  }
  const url = flags['upstream-proxy'];
  if (url === undefined) {
    return { systemProxy: flags['system-proxy'] };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--upstream-proxy must be an http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--upstream-proxy must be an http:// or https:// URL.');
  }
  const caFlag = flags['upstream-proxy-ca'];
  if (caFlag === undefined) {
    return { systemProxy: flags['system-proxy'], upstreamProxy: { url } };
  }
  const caPath = path.resolve(caFlag);
  let ca: string;
  try {
    ca = fs.readFileSync(caPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read --upstream-proxy-ca ${caPath}: ${(error as Error).message}`);
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`--upstream-proxy-ca ${caPath} is not a PEM certificate.`);
  }
  return { systemProxy: flags['system-proxy'], upstreamProxy: { url, ca }, upstreamProxyCaPath: caPath };
}

/** The proxy URL without credentials, for status output and stored state. */
export function upstreamProxyOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** Requires a selector unless the system proxy alone defines the tunnel. */
export function requireTunnelTarget(
  selectors: readonly string[] | undefined,
  systemProxy: boolean,
): string[] {
  if ((selectors === undefined || selectors.length === 0) && !systemProxy) {
    throw new Error('Pass at least one --selector, or --system-proxy.');
  }
  return [...(selectors ?? [])];
}
