import { DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES, DESTINATION_TUNNEL_MAX_BODY_BYTES } from '@limrun/api';
import IosTunnel from '../../ios/tunnel';
import AndroidTunnel, { validateAndroidTunnelInspectionFlags } from '.';

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
    expect(() => validateAndroidTunnelInspectionFlags(false, 'traffic.har')).toThrow(
      '--har cannot be combined with --no-inspect.',
    );
    expect(() => validateAndroidTunnelInspectionFlags(true, 'traffic.har')).not.toThrow();
  });

  test('does not expose inspection or HAR flags on iOS', () => {
    expect('inspect' in IosTunnel.flags).toBe(false);
    expect('har' in IosTunnel.flags).toBe(false);
    expect('har-body-limit' in IosTunnel.flags).toBe(false);
  });
});
