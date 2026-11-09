// Hand-written: the session-artifact list endpoint is not in the generated
// OpenAPI surface yet. Shared by the iOS and Android instance helpers.
// SessionLogLine, SessionEvent and PerformanceSample mirror
// pkg/artifacts/contract.go in the limrun repo; the runtimes emit the same JSON
// over live SSE and into the persisted JSONL artifacts.

/** The kind of a persisted session capture. */
export type SessionArtifactKind = 'recording' | 'appLog' | 'eventLog' | 'networkLog' | 'performance';

/**
 * One persisted session capture of an instance: a video recording, an app log
 * capture, a coalesced event log, a HAR network log, or iOS app performance
 * samples. Returned by the director's
 * GET /v1/{ios,android}_instances/{id}/session_artifacts endpoint, optionally
 * narrowed with its kind query parameter.
 */
export interface SessionArtifact {
  id: string;

  kind: SessionArtifactKind;

  /** Bundle id (iOS) or package name (Android) for app log captures. */
  bundleId?: string;

  /** Destination tunnel that produced a networkLog artifact. */
  tunnelId?: string;

  /** Canonical selectors captured by a networkLog artifact. */
  selectors?: string[];

  startedAt?: string;

  stoppedAt?: string;

  /** When the artifact is deleted from storage. */
  expiresAt?: string;

  sizeBytes?: number;

  /**
   * Short-lived presigned GET URL for the raw artifact: MP4 for recordings,
   * JSONL for app logs, event logs and performance samples, HAR for network
   * logs.
   */
  downloadUrl: string;
}

/**
 * One captured app log line, delivered live by `streamAppLogCapture` and stored
 * one-per-line in `appLog` artifacts.
 */
export interface SessionLogLine {
  /**
   * Epoch milliseconds: logcat's own timestamp on Android, receipt time on
   * iOS. Shares the clock of the recording artifact's `startedAt`, so lines
   * can be aligned with video playback offsets.
   */
  ts: number;

  line: string;
}

export type SessionEventType = 'tap' | 'drag' | 'scroll' | 'key' | 'text' | 'command';

/**
 * One coalesced user or agent action, delivered live by `streamEventCapture` and
 * stored one-per-line in `eventLog` artifacts. The runtime logs semantic
 * actions, never raw HID frames: a pointer sequence becomes one tap or drag,
 * scroll and keystroke bursts merge into one event, and typed text is never
 * included.
 */
export interface SessionEvent {
  /** The action's start in epoch milliseconds, same clock as SessionLogLine. */
  ts: number;

  type: SessionEventType;

  /** Touch point for tap, start point for drag, anchor for scroll. */
  x?: number;
  y?: number;

  /** Drag end point; for scroll they carry the burst's summed deltas instead. */
  toX?: number;
  toY?: number;

  /** Duration of the whole gesture or burst. */
  durationMs?: number;

  /** Number of merged actions in a scroll or text burst. */
  count?: number;

  /**
   * Short human-readable label, e.g. "launchApp com.example". Never carries
   * typed text or request payloads.
   */
  summary?: string;
}

/** One thread's share of an app's CPU in a {@link PerformanceSample}. */
export interface PerformanceThread {
  /** The thread's name, `main` for the main thread, or empty. */
  name: string;

  /** Share of one core; 100 is one fully busy core. */
  cpuPercent: number;
}

/**
 * One running app's resource use at one moment, the figures Xcode's debug
 * gauges show. iOS instances sample every running app they installed once a
 * second, delivered live by `streamPerformance` and stored one-per-line in
 * `performance` artifacts. Rates cover the second since the previous sample of
 * the same process, so a process's first sample has none.
 */
export interface PerformanceSample {
  /** Epoch milliseconds, same clock as SessionLogLine. */
  ts: number;

  bundleId: string;

  /** Changes when the app relaunches. */
  pid: number;

  /** The process start in epoch milliseconds. */
  startedAt: number;

  /** Set for XCTest runners such as WebDriverAgent. */
  testRunner?: boolean;

  /** One fully busy core is 100, so a multithreaded app can exceed it. */
  cpuPercent?: number;

  /** Physical footprint, the figure Xcode's memory gauge and iOS's memory limit use. */
  footprintBytes: number;

  /** The highest footprint over the process lifetime. */
  peakFootprintBytes: number;

  threadCount: number;

  diskReadBytesPerSecond?: number;

  diskWriteBytesPerSecond?: number;

  /**
   * Up to five threads using at least 0.1% of a core, busiest first. They add
   * up to roughly, not exactly, the app's `cpuPercent`.
   */
  topThreads?: PerformanceThread[];
}
