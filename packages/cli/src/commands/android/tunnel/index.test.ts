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
    const flags = { inspect: false, persist: false, har: 'traffic.har', 'har-body-limit': 1 };
    expect(() => validateTunnelInspectionFlags(flags)).toThrow('--har cannot be combined with --no-inspect.');
    expect(() => validateTunnelInspectionFlags({ ...flags, inspect: true })).not.toThrow();
  });

  test('requires persistence when a TTL is specified', () => {
    expect(AndroidTunnel.flags.ttl.dependsOn).toEqual(['persist']);
    expect(AndroidTunnel.flags.persist.default).toBe(false);
  });

  test('exposes the same inspection flags on iOS', () => {
    for (const flag of ['inspect', 'har', 'har-body-limit', 'persist', 'ttl'] as const) {
      expect(IosTunnel.flags[flag]).toBe(AndroidTunnel.flags[flag]);
    }
  });
});
