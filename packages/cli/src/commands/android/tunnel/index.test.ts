import { DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES, DESTINATION_TUNNEL_MAX_BODY_BYTES } from '@limrun/api';
import IosTunnel from '../../ios/tunnel';
import AndroidTunnel from '.';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tunnelInspectionContext } from '../../../lib/tunnel-inspection-flags';
import {
  UPSTREAM_PROXY_ENV,
  requireTunnelTarget,
  tunnelProxyContext,
  upstreamProxyOrigin,
} from '../../../lib/tunnel-proxy-flags';

describe('Android tunnel inspection flags', () => {
  test('enables inspection and the 10 MiB HAR limit by default', () => {
    expect(AndroidTunnel.flags.inspect.default).toBe(true);
    expect(AndroidTunnel.flags.inspect.allowNo).toBe(true);
    expect(AndroidTunnel.flags['har-body-limit'].default).toBe(DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES);
    expect((AndroidTunnel.flags['har-body-limit'] as unknown as { max: number }).max).toBe(
      DESTINATION_TUNNEL_MAX_BODY_BYTES,
    );
  });

  test('rejects HAR capture when inspection is disabled', () => {
    const flags = { inspect: false, persist: false, har: 'traffic.har', 'har-body-limit': 1 };
    expect(() => tunnelInspectionContext(flags)).toThrow('--har cannot be combined with --no-inspect.');
    expect(() => tunnelInspectionContext({ ...flags, inspect: true })).not.toThrow();
  });

  test('requires persistence when a TTL is specified', () => {
    const flags = { inspect: true, persist: false, ttl: 3600, 'har-body-limit': 1 };
    expect(() => tunnelInspectionContext(flags)).toThrow('--ttl is only valid with --persist.');
    expect(() => tunnelInspectionContext({ ...flags, persist: true })).not.toThrow();
  });

  test('exposes the same inspection flags on iOS', () => {
    for (const flag of ['inspect', 'har', 'har-body-limit', 'persist', 'ttl'] as const) {
      expect(IosTunnel.flags[flag]).toBe(AndroidTunnel.flags[flag]);
    }
  });
});

describe('tunnel system and upstream proxy flags', () => {
  const noProxy = { 'system-proxy': false };

  test('are shared by iOS and Android and read the upstream URL from the environment', () => {
    for (const flag of ['system-proxy', 'upstream-proxy', 'upstream-proxy-ca'] as const) {
      expect(IosTunnel.flags[flag]).toBe(AndroidTunnel.flags[flag]);
    }
    expect(AndroidTunnel.flags['upstream-proxy'].env).toBe(UPSTREAM_PROXY_ENV);
    expect(AndroidTunnel.flags.selector.required).toBeFalsy();
  });

  test('requires inspection for the system proxy', () => {
    expect(() => tunnelProxyContext({ 'system-proxy': true }, false)).toThrow(
      '--system-proxy cannot be combined with --no-inspect.',
    );
    expect(tunnelProxyContext({ 'system-proxy': true }, true)).toEqual({ systemProxy: true });
  });

  test('requires a selector unless the system proxy defines the tunnel', () => {
    expect(() => requireTunnelTarget(undefined, false)).toThrow(
      'Pass at least one --selector, or --system-proxy.',
    );
    expect(requireTunnelTarget(undefined, true)).toEqual([]);
    expect(requireTunnelTarget(['localhost:8081'], true)).toEqual(['localhost:8081']);
  });

  test('accepts only http and https upstream proxies and reads the CA file', () => {
    expect(() => tunnelProxyContext({ ...noProxy, 'upstream-proxy': 'socks5://rec:1080' }, true)).toThrow(
      'must be an http:// or https:// URL',
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-proxy-ca-'));
    const caPath = path.join(directory, 'ca.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    expect(
      tunnelProxyContext(
        { ...noProxy, 'upstream-proxy': 'http://rec:8080', 'upstream-proxy-ca': caPath },
        true,
      ),
    ).toEqual({
      systemProxy: false,
      upstreamProxy: { url: 'http://rec:8080', ca: fs.readFileSync(caPath, 'utf8') },
      upstreamProxyCaPath: caPath,
    });
    fs.writeFileSync(caPath, 'not a certificate');
    expect(() =>
      tunnelProxyContext(
        { ...noProxy, 'upstream-proxy': 'http://rec:8080', 'upstream-proxy-ca': caPath },
        true,
      ),
    ).toThrow('is not a PEM certificate');
  });

  test('keeps upstream proxy credentials out of stored state', () => {
    expect(upstreamProxyOrigin('http://user:secret@rec.internal:8080/path')).toBe('http://rec.internal:8080');
  });
});
