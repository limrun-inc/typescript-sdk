import { DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES, DESTINATION_TUNNEL_MAX_BODY_BYTES } from '@limrun/api';
import IosTunnel from '../../ios/tunnel';
import AndroidTunnel from '.';
import { validateTunnelInspectionFlags } from '../../../lib/tunnel-inspection-flags';

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
    expect(() => validateTunnelInspectionFlags(false, 'traffic.har')).toThrow(
      '--har cannot be combined with --no-inspect.',
    );
    expect(() => validateTunnelInspectionFlags(true, 'traffic.har')).not.toThrow();
  });

  test('requires persistence when a TTL is specified', () => {
    expect(() => validateTunnelInspectionFlags(true, undefined, false, 3600)).toThrow(
      '--ttl is only valid with --persist.',
    );
    expect(() => validateTunnelInspectionFlags(false, undefined, true, 3600)).not.toThrow();
    expect(AndroidTunnel.flags.persist.default).toBe(false);
  });

  test('exposes the same inspection flags on iOS', () => {
    for (const flag of ['inspect', 'har', 'har-body-limit', 'persist', 'ttl'] as const) {
      expect(IosTunnel.flags[flag]).toBe(AndroidTunnel.flags[flag]);
    }
  });
});
