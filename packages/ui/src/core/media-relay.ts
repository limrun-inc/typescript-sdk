type UnknownRecord = Record<string, unknown>;

export interface MediaRelaySupport {
  camera: boolean;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const supportsVersionOne = (value: unknown): boolean => isRecord(value) && value.version === 1;

/**
 * Reads the platform-neutral camera relay capability from an
 * rtcConfiguration response. Servers that omit or version-mismatch the
 * capability keep the legacy receive-only SDP shape.
 */
export const getMediaRelaySupport = (response: unknown): MediaRelaySupport => {
  if (!isRecord(response)) {
    return { camera: false };
  }
  const rtcConfiguration = isRecord(response.rtcConfiguration) ? response.rtcConfiguration : undefined;
  const capabilitySources = [
    isRecord(response.capabilities) ? response.capabilities : undefined,
    isRecord(rtcConfiguration?.capabilities) ? rtcConfiguration.capabilities : undefined,
    rtcConfiguration,
  ];
  return {
    camera: capabilitySources.some((capabilities) => supportsVersionOne(capabilities?.cameraRelay)),
  };
};
