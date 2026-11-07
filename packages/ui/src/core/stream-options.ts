import type { AxSnapshot } from './ax-tree';
import type { AndroidElementTreeOptions, AxStatus } from './ax-fetcher';
import type { CameraCaptureInfo } from './camera';
import type { DuoState } from './duo';
import type { PlaybackStats } from './playback-stats';
import type { CameraStreamStats, MicrophoneState, RemoteControlConnectionState } from './stream-types';

export type StreamDisplay = 'primary' | 'inner';

export interface DeviceFrameSink {
  /** The source is borrowed for this call. Copy it before returning if retaining a frame. */
  present(source: CanvasImageSource, width: number, height: number, display: StreamDisplay): void;
}

export interface DeviceStreamState {
  connection: RemoteControlConnectionState | 'idle';
  videoReady: boolean;
  controlReady: boolean;
  duo: boolean;
  duoState: DuoState | null;
  duoError?: string;
}

export interface DeviceStreamTransport {
  /** Return a fresh, unopened or open WebSocket for each attempt. The client owns its lifetime. */
  connect(): WebSocket | Promise<WebSocket>;
  /** Optional authoritative lifecycle check. Omit when the proxy cannot distinguish termination. */
  isTerminated?(): Promise<boolean>;
}

/** Options that can change without replacing the connection. */
export interface DeviceStreamLiveOptions {
  /** Applied on the next connection attempt. */
  openUrl?: string;
  axPollIntervalMs?: number;
  axMaxBackoffMs?: number;
  androidElementTreeOptions?: AndroidElementTreeOptions;
  autoReconnect?: boolean;
  jitterBufferTargetMs?: number | null;
  microphoneEnabled?: boolean;
  inspectMode?: boolean | 'hover-only';
  onStateChange?: (state: DeviceStreamState) => void;
  onConnectionStateChange?: (state: RemoteControlConnectionState) => void;
  onTerminated?: () => void;
  onPlaybackStats?: (stats: PlaybackStats | null) => void;
  onTrace?: (message: Record<string, unknown>) => void;
  onAxSnapshotChange?: (snapshot: AxSnapshot | null) => void;
  onAxStatusChange?: (status: AxStatus, error?: string) => void;
  onCameraDemandChange?: (active: boolean, granted?: boolean, camera?: CameraCaptureInfo) => void;
  onCameraStats?: (stats: CameraStreamStats | null) => void;
  onMicrophoneStateChange?: (state: MicrophoneState) => void;
}

export type DeviceStreamOptions = DeviceStreamLiveOptions & {
  sessionId?: string;
  /** Required with proxy transports; direct instance URLs can supply the platform implicitly. */
  platform?: 'ios' | 'android';
  deviceModel?: 'iphone-duo';
} & (
    | { url: string; token: string; transport?: never }
    | { transport: DeviceStreamTransport; platform: 'ios' | 'android'; url?: never; token?: never }
  );
