/**
 * Snapshot of the live-microphone pipeline, reported through
 * `onMicrophoneStateChange`.
 */
export interface MicrophoneState {
  /** True while the browser mic is captured and streaming to the sim. */
  active: boolean;
  /**
   * Human-readable failure from the last attempt, if any (permission
   * denied, no device, host rejection, ...).
   */
  error?: string;
  /** Device label of the captured microphone, when available. */
  label?: string;
}

/**
 * Live outbound-camera quality snapshot. Derived from
 * `RTCPeerConnection.getStats()` and rate-derived deltas, sampled
 * once per second while the camera is sending. All fields optional:
 * some browsers omit fields (Safari rarely reports
 * `encoderImplementation`), and the first sample after camera start
 * has no delta-derived numbers yet.
 */
export interface CameraStreamStats {
  /** "H264", "HEVC"/"H265", "VP9", "VP8", "AV1", etc. (uppercased). */
  codec?: string;
  /** e.g. "VideoToolbox" (hw), "OpenH264" (sw), "ExternalEncoder". */
  encoderImplementation?: string;
  /**
   * Browser-reported hardware-acceleration hint. Some Chromium
   * versions expose this via `powerEfficientEncoder`; we mirror it
   * here so consumers don't have to know the spec quirk.
   */
  hardwareAccelerated?: boolean;
  /** Outbound encoded fps over the last sample window. */
  framesPerSecond?: number;
  /** Cumulative encoded frame count. */
  framesEncoded?: number;
  /** Outbound encoded bitrate (bits/s) over the last window. */
  bitrateBps?: number;
  /** Width/height the encoder is currently producing. */
  width?: number;
  height?: number;
  /**
   * One of `'none' | 'cpu' | 'bandwidth' | 'other'`. Mirrors
   * Meet/Zoom's "limited by …" banners. Anything other than
   * `'none'` means the encoder dropped resolution to keep up.
   */
  qualityLimitationReason?: string;
  /** Round-trip time in milliseconds, from the matching RTCP. */
  rttMs?: number;
  /** Packet-loss percentage over the last sample window (0..100). */
  packetsLostPct?: number;
}

export interface ScreenshotData {
  dataUri: string;
}

export interface ImperativeKeyboardEvent {
  type: 'keydown' | 'keyup';
  code: string; // e.g., "KeyA", "Enter", "ShiftLeft"
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export type RemoteControlConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'terminated';
