import { describe, expect, it } from 'vitest';

import { getMediaRelaySupport } from './media-relay';

describe('getMediaRelaySupport', () => {
  it('enables only an explicitly versioned camera capability', () => {
    expect(
      getMediaRelaySupport({
        rtcConfiguration: { iceServers: [] },
        capabilities: {
          cameraRelay: { version: 1 },
        },
      }),
    ).toEqual({ camera: true });
  });

  it('keeps legacy responses on the receive-only SDP shape', () => {
    expect(getMediaRelaySupport({ rtcConfiguration: { iceServers: [] } })).toEqual({
      camera: false,
    });
    expect(
      getMediaRelaySupport({
        rtcConfiguration: { iceServers: [] },
        capabilities: { cameraRelay: true },
      }),
    ).toEqual({ camera: false });
  });

  it('accepts a camera capability directly on rtcConfiguration', () => {
    expect(
      getMediaRelaySupport({
        rtcConfiguration: {
          iceServers: [],
          cameraRelay: { version: 1 },
        },
      }),
    ).toEqual({ camera: true });
  });
});
