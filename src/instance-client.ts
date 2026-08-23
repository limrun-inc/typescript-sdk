import { WebSocket, Data } from 'ws';
import { execFile } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { downloadFileToLocalPath } from './internal/download-file';
import { bootstrapAndroidBasisCache } from './internal/android-basis-cache';
import { nodeProxyTransport } from './internal/proxy-transport';
import { startTcpTunnel, isNonRetryableError } from './tunnel';
import type { Tunnel } from './tunnel';
import { syncFolder, type FolderSyncOptions, type SyncFolderResult } from './folder-sync';
import { startDestinationTcpTunnel, type DestinationTcpTunnel } from './destination-tunnel-dialer';
import type { DestinationTunnelRoute } from './destination-tunnel';
import {
  getDestinationTunnelStatus,
  stopDestinationTunnel,
  type DestinationTunnelStatus,
} from './internal/destination-tunnel-management';
import { deriveDestinationTunnelURL } from './internal/destination-tunnel-url';

const ANDROID_RECORDING_PATH = '/data/local/tmp/recordings/video_recording.mp4';
const ANDROID_SIGNALING_PATH = '/ws';
const ANDROID_TUNNEL_DEFAULT_WINDOW = 1024 * 1024;

/** Transparent destination tunnel from the Android instance to this machine. */
export type DestinationTunnel = DestinationTcpTunnel;
export type DestinationTunnelOptions = {
  /** Exact localhost or literal-IP TCP destinations, served on-device via bind listeners. */
  routes?: DestinationTunnelRoute[];
  /** Exact or `*.` wildcard domains intercepted on-device via fake-IP DNS. */
  domains?: string[];
  /** IPv4 CIDR destinations intercepted on-device via TPROXY. */
  cidrs?: string[];
  /** Per-flow receive window in bytes. Defaults to 1 MiB. */
  window?: number;
  /** Controls tunnel logging verbosity. Defaults to the instance client's log level. */
  logLevel?: LogLevel;
};
export type { DestinationTunnelStatus } from './internal/destination-tunnel-management';

/**
 * Connection state of the instance client
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Callback function for connection state changes
 */
export type ConnectionStateCallback = (state: ConnectionState) => void;

function deriveEndpointWebSocketUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}${ANDROID_SIGNALING_PATH}`;
  return parsed.toString().replace(/\/$/, '');
}

function buildDownloadUrl(apiUrl: string): string {
  return `${apiUrl}/files?path=${encodeURIComponent(ANDROID_RECORDING_PATH)}`;
}

function assertBandwidthKbps(field: keyof WifiBandwidthOptions, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer Kbps value`);
  }
}

async function assertApkFile(filePath: string): Promise<void> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (!st?.isFile()) {
    throw new Error(`APK file not found: ${filePath}`);
  }
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fd.read(buf, 0, 4, 0);
    if (bytesRead < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`File is not an APK/ZIP archive: ${filePath}`);
    }
  } finally {
    await fd.close();
  }
}

/**
 * A client for interacting with a Limbar instance
 */
export type InstanceClient = {
  /**
   * Take a screenshot of the current screen
   * @returns A promise that resolves to the screenshot data
   */
  screenshot: () => Promise<ScreenshotData>;
  /**
   * Fetch Android UI hierarchy from UIAutomator.
   */
  getElementTree: (options?: AndroidElementTreeOptions) => Promise<ElementTreeData>;
  /**
   * Find matching elements by Android-native selector.
   */
  findElement: (selector: AndroidSelector, limit?: number) => Promise<FindElementResult>;
  /**
   * Tap an element by selector/reference (or explicit coordinates).
   */
  tap: (target: AndroidElementTarget) => Promise<TapResult>;
  /**
   * Set text into an element or currently focused input.
   */
  setText: (target: AndroidElementTarget | undefined, text: string) => Promise<SetTextResult>;
  /**
   * Press an Android key by key name, optionally with modifiers.
   * Accepted key strings are case-insensitive and may be plain names like
   * `'BACK'`, `'ENTER'`, `'A'`, `'TAB'`, full Android constants like
   * `'KEYCODE_TAB'`, or digit strings like `'4'`.
   * Supported modifiers are `'shift'`, `'ctrl'`/`'control'`, `'alt'`/`'option'`,
   * `'meta'`/`'command'`/`'cmd'`, `'sym'`, and `'fn'`/`'function'`.
   */
  pressKey: (key: string, modifiers?: string[]) => Promise<PressKeyResult>;
  /**
   * Scroll around the entire screen.
   */
  scrollScreen: (direction: ScrollDirection, amount?: number) => Promise<ScrollResult>;
  /**
   * Scroll inside an element matched by selector/reference.
   */
  scrollElement: (
    target: AndroidElementTarget,
    direction: ScrollDirection,
    amount?: number,
  ) => Promise<ScrollResult>;
  /**
   * Open a URL/deeplink on Android.
   */
  openUrl: (url: string) => Promise<OpenUrlResult>;
  /**
   * Launch an installed app by package name.
   *
   * Pass `onExit` to be notified when the app shuts down. The callback receives
   * the app's recent logcat output and structured exit details, including the
   * crash stack trace when the app crashed, so failures can be diagnosed
   * without a follow-up round trip.
   *
   * @param packageName Package name of the app to launch
   * @param options Optional launch options:
   *   - mode: 'ForegroundIfRunning' (default) brings the app to foreground if
   *     already running; 'RelaunchIfRunning' kills and relaunches it
   *   - onExit: callback invoked once when the app shuts down
   */
  launchApp: (packageName: string, options?: LaunchAppOptions) => Promise<LaunchAppResult>;
  /**
   * Terminate a running app by package name (force-stop). If the app was
   * launched with an `onExit` callback, that callback fires with reason
   * `'terminated'`.
   *
   * @param packageName Package name of the app to terminate
   */
  terminateApp: (packageName: string) => Promise<void>;
  /**
   * Watch an app's exit/crash without launching it through {@link launchApp},
   * e.g. for apps that are already running or will be opened via a deeplink
   * (see {@link openUrl}). The callback fires once, with the same payload as a
   * launch-attached `onExit` (recent logs plus crash/ANR details), when the app
   * crashes, ANRs, exits, or is terminated.
   *
   * The app must be installed, but does not need to be running yet: if it
   * starts later, its processes are picked up automatically.
   *
   * @param packageName Package name of the app to watch
   * @param onExit Called once when the watched app shuts down
   * @returns A handle whose `stop()` cancels the watch
   */
  watchApp: (packageName: string, onExit: LaunchAppExitCallback) => Promise<AppWatch>;
  /**
   * Play an on-device WAV/MP3 file as microphone input.
   *
   * The file must already exist on the Android instance, for example after
   * uploading it with {@link pushFile} or pushing it with ADB.
   */
  playOnMicrophone: (path: string, options?: PlayOnMicrophoneOptions) => Promise<PlayOnMicrophoneResult>;
  /**
   * Upload a local file to the instance, without needing an ADB connection.
   *
   * With no destination, the instance stores the file under an internal name
   * and returns its path. With a destination, behaves like `adb push`: the
   * write is performed with the same permissions the ADB shell user has, so
   * writable locations (e.g. `/data/local/tmp`, `/sdcard`) succeed and
   * protected ones are rejected, exactly as they would be for `adb push`.
   *
   * @param path The path of the local file to upload.
   * @param destination Optional absolute path on the instance to write to.
   * @returns A promise that resolves to the absolute path of the file on the
   *   instance, usable with {@link playOnMicrophone}.
   */
  pushFile: (path: string, destination?: string) => Promise<string>;
  /**
   * Download a file from the instance, without needing an ADB connection.
   *
   * Behaves like `adb pull`: the read is performed with the same permissions
   * the ADB shell user has, so readable locations (e.g. `/data/local/tmp`,
   * `/sdcard`) succeed and protected ones are rejected, exactly as they would
   * be for `adb pull`.
   *
   * The content is streamed to `localPath` without being buffered in memory,
   * so arbitrarily large files can be pulled.
   *
   * @param path Absolute path of the file on the instance.
   * @param localPath Local path to stream the file to.
   */
  pullFile: (path: string, localPath: string) => Promise<void>;
  /**
   * Play a local video file as the camera feed.
   *
   * Uploads the file to the instance and switches the virtual camera source
   * to it, replacing the live WebRTC camera until {@link clearCameraVideo} is
   * called. Apps see the video through their regular Camera2/CameraX
   * pipeline, and the file's audio track (if any) plays through the
   * microphone in sync.
   *
   * By default the video loops; with `loop: false` it plays once and the
   * feed freezes on the last frame.
   *
   * @param path The path of the local video file to play as the camera.
   * @param opts Playback options (currently just `loop`).
   * @throws If the file has no decodable video track or the instance does not
   *   support camera injection (Android 14 and older).
   */
  setCameraVideo: (path: string, opts?: CameraVideoOptions) => Promise<void>;
  /**
   * Stop video-file camera playback and restore the default WebRTC camera
   * source. Safe to call when no video is playing.
   */
  clearCameraVideo: () => Promise<void>;
  /**
   * Run a shell command on the instance, without needing `adb` installed
   * locally. The command runs with the same permissions the ADB shell user
   * has (exactly like `adb shell`), and its stdout, stderr, and exit code are
   * returned separately.
   *
   * The command and each argument are safely quoted before being sent, so
   * argument values cannot be interpreted as extra shell syntax (no injection
   * from untrusted args), mirroring `child_process.execFile`:
   *
   * ```ts
   * await client.adbShell('pm', ['list', 'packages', '-3']);
   * await client.adbShell('getprop', ['ro.build.version.sdk']);
   * ```
   *
   * To use shell features such as pipes or redirection, invoke a shell
   * explicitly and pass the script as an argument:
   *
   * ```ts
   * await client.adbShell('sh', ['-c', 'dumpsys battery | grep level']);
   * ```
   *
   * @param command The executable or shell builtin to run.
   * @param args Arguments passed to the command; each is individually quoted.
   * @throws If the command times out or the ADB transport is unavailable. A
   *   non-zero `exitCode` is returned in the result, not thrown.
   */
  adbShell: (command: string, args?: string[], options?: AdbShellOptions) => Promise<AdbShellResult>;
  /**
   * Set Android Wi-Fi bandwidth limits in Kbps. Omit a direction to leave it unchanged;
   * pass `0` to clear that direction's limit.
   */
  setWifiBandwidth: (options: WifiBandwidthOptions) => Promise<void>;
  /**
   * Start recording device video. Use stopRecording() to finish the recording.
   * When provided, `quality` must be one of `5`, `6`, `7`, `8`, `9`, or `10`.
   * The server default is `5`.
   */
  startRecording: (options?: { quality?: RecordingQuality }) => Promise<void>;
  /**
   * Stop the active server-side recording.
   * If `saveTo.presignedUrl` is provided, the server uploads the completed file there before resolving.
   * If `saveTo.localPath` is provided, the client downloads the completed file to that path.
   * Returns a download URL for the completed recording.
   */
  stopRecording: (saveTo: { presignedUrl?: string; localPath?: string }) => Promise<string>;
  /** Send an application-level keepAlive message on the control websocket. */
  keepAlive: () => void;
  /**
   * Disconnect from the Limbar instance
   */
  disconnect: () => void;

  /**
   * Establish an ADB tunnel to the instance.
   * Returns the local TCP port and a cleanup function.
   */
  startAdbTunnel: () => Promise<Tunnel>;

  /**
   * Transparently route declared Android TCP destinations through this
   * machine. Exact `localhost` routes are also reachable on-device as
   * `10.0.2.2:<port>`, following the emulator convention.
   *
   * The caller owns the returned tunnel and must close it. Disconnecting this
   * instance client does not close the tunnel.
   */
  startTunnel: (options: DestinationTunnelOptions) => Promise<DestinationTunnel>;

  /** Get the active destination tunnel and most recent terminal failure. */
  getTunnelStatus: () => Promise<DestinationTunnelStatus>;

  /** Stop the active destination tunnel only when its ID matches `tunnelId`. */
  stopTunnel: (tunnelId: string) => Promise<void>;
  /**
   * Send an asset URL to the instance. The instance will download the asset
   * and process it (currently APK install is supported). Resolves on success,
   * rejects with an Error on failure.
   */
  sendAsset: (url: string, timeoutMs?: number) => Promise<void>;

  /**
   * Delta-sync a local APK to the instance and install it.
   */
  syncApp: (
    apkPath: string,
    opts?: {
      install?: boolean;
      watch?: boolean;
      launchMode?: 'ForegroundIfRunning' | 'RelaunchIfRunning';
      basisCacheDir?: string;
      /**
       * Called while missing basis-seed ranges are downloaded from the instance. Fires
       * once with `(0, requiredDownloadBytes)` before transfer, then repeatedly as bytes
       * arrive. A full-download fallback restarts progress with the complete seed size.
       */
      onBasisDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void;
      /** Called after every successful sync, including watch-triggered re-syncs. */
      onSyncComplete?: FolderSyncOptions['onSyncComplete'];
    },
  ) => Promise<SyncFolderResult>;

  /**
   * Get current connection state
   */
  getConnectionState: () => ConnectionState;

  /**
   * Register callback for connection state changes
   * @returns A function to unregister the callback
   */
  onConnectionStateChange: (callback: ConnectionStateCallback) => () => void;
};

/**
 * Controls the verbosity of logging in the client
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export enum RecordingQuality {
  Q5 = 5,
  Q6 = 6,
  Q7 = 7,
  Q8 = 8,
  Q9 = 9,
  Q10 = 10,
}

export type AndroidSelector = {
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  className?: string;
  packageName?: string;
  index?: number;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  boundsContains?: {
    x: number;
    y: number;
  };
};

export type AndroidElementTarget = {
  selector?: AndroidSelector;
  x?: number;
  y?: number;
};

export type AndroidElementNode = {
  index?: string;
  text?: string;
  resourceId?: string;
  className?: string;
  packageName?: string;
  contentDesc?: string;
  clickable?: boolean;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  scrollable?: boolean;
  selected?: boolean;
  bounds?: string;
  parsedBounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    centerX: number;
    centerY: number;
  };
};

export type AndroidElementTreeOptions = {
  waitForIdleTimeoutMs?: number;
};

/**
 * Configuration options for creating an Instance API client
 */
export type InstanceClientOptions = {
  /**
   * HTTP base URL for the Android daemon. WebSocket control is derived from it
   * using the `/ws` path, and recording downloads use the same base URL.
   */
  apiUrl: string;
  /**
   * The URL of the ADB WebSocket endpoint.
   */
  adbUrl?: string;
  /**
   * The token to use for the WebSocket connections.
   */
  token: string;
  /**
   * Path to the ADB executable.
   * @default 'adb'
   */
  adbPath?: string;
  /**
   * Controls logging verbosity
   * @default 'info'
   */
  logLevel?: LogLevel;
  /**
   * Maximum number of reconnection attempts
   * @default 6
   */
  maxReconnectAttempts?: number;
  /**
   * Initial reconnection delay in milliseconds
   * @default 1000
   */
  reconnectDelay?: number;
  /**
   * Maximum reconnection delay in milliseconds
   * @default 30000
   */
  maxReconnectDelay?: number;
};

type ScreenshotResponse = {
  type: 'screenshot';
  dataUri: string;
  id: string;
};

type ScreenshotData = {
  dataUri: string;
};

export type ElementTreeData = {
  xml: string;
  nodes: AndroidElementNode[];
};

export type FindElementResult = {
  elements: AndroidElementNode[];
  count: number;
};

export type TapResult = {
  x: number;
  y: number;
};

export type SetTextResult = {
  textLength: number;
};

export type PressKeyResult = {
  key: string;
};

export type ScrollResult = {
  direction: ScrollDirection;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type OpenUrlResult = {
  url: string;
};

export type LaunchAppMode = 'ForegroundIfRunning' | 'RelaunchIfRunning';

/**
 * Why a launched app shut down.
 * - `crash`: the app process crashed (Java or native); `crash` details are attached.
 * - `anr`: the app stopped responding and was killed; `anr` details are attached.
 * - `exit`: all of the app's processes exited without a crash.
 * - `terminated`: the app was stopped via {@link InstanceClient.terminateApp}.
 */
export type AppExitReason = 'crash' | 'anr' | 'exit' | 'terminated';

export type AppCrashInfo = {
  processName: string;
  pid: number;
  shortMsg: string;
  longMsg: string;
  /** Full stack trace of the crash (Java throwable trace or native crash summary). */
  stackTrace: string;
  timeMillis: number;
};

export type AppAnrInfo = {
  processName: string;
  pid: number;
  /** CPU/process state dump captured by the system when the ANR was detected. */
  processStats: string;
};

export type AppExitInfo = {
  packageName: string;
  reason: AppExitReason;
  crash?: AppCrashInfo;
  anr?: AppAnrInfo;
};

/**
 * Called when the launched app shuts down. The logs array contains one entry
 * per logcat line recently produced by the app (filtered by its UID), and
 * `info` carries the exit reason plus crash/ANR details when applicable.
 */
export type LaunchAppExitCallback = (logs: string[], info: AppExitInfo) => Promise<void> | void;

export type LaunchAppOptions = {
  /**
   * Launch behavior when the app may already be running.
   * Defaults to `ForegroundIfRunning` server-side.
   */
  mode?: LaunchAppMode;
  /** Called when the launched app exits, crashes, ANRs, or is terminated. */
  onExit?: LaunchAppExitCallback;
};

export type LaunchAppResult = {
  packageName: string;
};

/** Handle for an app watch registered via {@link InstanceClient.watchApp}. */
export type AppWatch = {
  /** Identifier of this watch on the server. */
  execId: string;
  /** Cancels the watch; the onExit callback will not be invoked afterwards. */
  stop: () => Promise<void>;
};

export type PlayOnMicrophoneOptions = {
  once?: boolean;
};

/**
 * Options for playing a video file as the virtual camera feed.
 */
export type CameraVideoOptions = {
  /**
   * Whether to restart the video when it ends. When false the video
   * plays once and the camera feed freezes on its last frame.
   * @default true
   */
  loop?: boolean;
};

export type PlayOnMicrophoneResult = {
  /** Duration of the decoded audio in microseconds. */
  duration: number;
  once: boolean;
  generation: number;
};

export type WifiBandwidthOptions = {
  downKbps?: number;
  upKbps?: number;
};

/**
 * Quotes each token so the remote `sh -c` receives them as literal,
 * separate arguments — values cannot inject extra shell syntax. Uses
 * POSIX single-quoting: wrap in single quotes and escape embedded single
 * quotes as `'\''`.
 */
function quoteShellArgs(tokens: string[]): string {
  return tokens.map((token) => `'${token.replace(/'/g, `'\\''`)}'`).join(' ');
}

/**
 * Options for {@link InstanceClient.adbShell}.
 */
export type AdbShellOptions = {
  /**
   * Maximum time to wait for the command to finish, in milliseconds.
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * Encoding used to decode stdout/stderr into strings.
   * @default 'utf8'
   */
  encoding?: BufferEncoding;
};

/**
 * Result of a shell command run via {@link InstanceClient.adbShell}.
 */
export type AdbShellResult = {
  /** Standard output, decoded with the requested encoding. */
  stdout: string;
  /** Standard error, decoded with the requested encoding. */
  stderr: string;
  /** Process exit code (`-1` if the device reported no exit status). */
  exitCode: number;
  /** True if output exceeded the capture limit and was truncated. */
  truncated: boolean;
};

type EmptyCommandResult = Record<string, never>;

type ScreenshotErrorResponse = {
  type: 'screenshotError';
  message: string;
  id: string;
};

type AssetRequest = {
  type: 'asset';
  url: string;
};

type AssetResultResponse = {
  type: 'assetResult';
  result: 'success' | 'failure' | string;
  url: string;
  message?: string;
};

type CommandError = {
  code?: string;
  message?: string;
  retriable?: boolean;
};

type ScreenshotResultMessage = {
  type: 'screenshotResult';
  id: string;
  payload?: ScreenshotData;
  error?: CommandError;
};

type GetElementTreeResultMessage = {
  type: 'getElementTreeResult';
  id: string;
  payload?: ElementTreeData;
  error?: CommandError;
};

type FindElementResultMessage = {
  type: 'findElementResult';
  id: string;
  payload?: FindElementResult;
  error?: CommandError;
};

type TapResultMessage = {
  type: 'tapResult';
  id: string;
  payload?: TapResult;
  error?: CommandError;
};

type SetTextResultMessage = {
  type: 'setTextResult';
  id: string;
  payload?: SetTextResult;
  error?: CommandError;
};

type PressKeyResultMessage = {
  type: 'pressKeyResult';
  id: string;
  payload?: PressKeyResult;
  error?: CommandError;
};

type ScrollScreenResultMessage = {
  type: 'scrollScreenResult';
  id: string;
  payload?: ScrollResult;
  error?: CommandError;
};

type ScrollElementResultMessage = {
  type: 'scrollElementResult';
  id: string;
  payload?: ScrollResult;
  error?: CommandError;
};

type OpenUrlResultMessage = {
  type: 'openUrlResult';
  id: string;
  payload?: OpenUrlResult;
  error?: CommandError;
};

type LaunchAppResultMessage = {
  type: 'launchAppResult';
  id: string;
  payload?: LaunchAppResult;
  error?: CommandError;
};

type TerminateAppResultMessage = {
  type: 'terminateAppResult';
  id: string;
  payload?: { packageName?: string };
  error?: CommandError;
};

type WatchAppResultMessage = {
  type: 'watchAppResult';
  id: string;
  payload?: { packageName?: string };
  error?: CommandError;
};

type UnwatchAppResultMessage = {
  type: 'unwatchAppResult';
  id: string;
  payload?: EmptyCommandResult;
  error?: CommandError;
};

type AppExitMessage = {
  type: 'appExit';
  execId: string;
  packageName: string;
  reason: AppExitReason;
  crash?: AppCrashInfo;
  anr?: AppAnrInfo;
  logs?: string[];
};

type PlayOnMicrophoneResultMessage = {
  type: 'playOnMicrophoneResult';
  id: string;
  payload?: PlayOnMicrophoneResult;
  error?: CommandError;
};

// The server sends camera control results "flat": fields at the top level and
// `error` as a plain string, with no payload envelope.
type CameraControlResultMessage = {
  type: 'cameraControlResult';
  id: string;
  payload?: EmptyCommandResult;
  error?: string;
};

type SetWifiBandwidthResultMessage = {
  type: 'setWifiBandwidthResult';
  id: string;
  payload?: EmptyCommandResult;
  error?: CommandError;
};

// The server sends adb shell results "flat": stdout/stderr (base64) and
// exitCode at the top level, with `error` as a plain string.
type AdbShellResultMessage = {
  type: 'adbShellResult';
  id: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  payload?: EmptyCommandResult;
  error?: string;
};

type StartVideoRecordingResultMessage = {
  type: 'startRecordingResult';
  id: string;
  payload?: EmptyCommandResult;
  error?: CommandError;
};

type StopVideoRecordingResultMessage = {
  type: 'stopRecordingResult';
  id: string;
  payload?: EmptyCommandResult;
  error?: CommandError;
};

type KnownCommandResultMessage =
  | ScreenshotResultMessage
  | GetElementTreeResultMessage
  | FindElementResultMessage
  | TapResultMessage
  | SetTextResultMessage
  | PressKeyResultMessage
  | ScrollScreenResultMessage
  | ScrollElementResultMessage
  | OpenUrlResultMessage
  | LaunchAppResultMessage
  | TerminateAppResultMessage
  | WatchAppResultMessage
  | UnwatchAppResultMessage
  | PlayOnMicrophoneResultMessage
  | CameraControlResultMessage
  | AdbShellResultMessage
  | SetWifiBandwidthResultMessage
  | StartVideoRecordingResultMessage
  | StopVideoRecordingResultMessage;

type ServerMessage =
  | ScreenshotResponse
  | ScreenshotErrorResponse
  | AssetResultResponse
  | KnownCommandResultMessage
  | { type: string; [key: string]: unknown };

type CommandRequestMap = {
  screenshot: {};
  getElementTree: AndroidElementTreeOptions;
  findElement: { selector: AndroidSelector; limit?: number };
  tap: AndroidElementTarget;
  setText: { text: string } & AndroidElementTarget;
  pressKey: { keyName?: string; key?: string; modifiers?: string[] };
  scrollScreen: { direction: ScrollDirection; amount?: number };
  scrollElement: AndroidElementTarget & { direction: ScrollDirection; amount?: number };
  openUrl: { url: string };
  launchApp: { packageName: string; mode?: LaunchAppMode; execId?: string };
  terminateApp: { packageName: string };
  watchApp: { packageName: string; execId: string };
  unwatchApp: { execId: string };
  playOnMicrophone: { path: string; once?: boolean };
  cameraControl: { action: 'setSource'; source: 'video'; arg: string; loop?: boolean } | { action: 'reset' };
  adbShell: { command: string; timeoutMs?: number };
  setWifiBandwidth: WifiBandwidthOptions;
  startRecording: { quality?: RecordingQuality };
  stopRecording: { upload?: { presignedUrl: string } };
};

type CommandResultMap = {
  screenshot: ScreenshotData;
  getElementTree: ElementTreeData;
  findElement: FindElementResult;
  tap: TapResult;
  setText: SetTextResult;
  pressKey: PressKeyResult;
  scrollScreen: ScrollResult;
  scrollElement: ScrollResult;
  openUrl: OpenUrlResult;
  launchApp: LaunchAppResult;
  terminateApp: { packageName?: string };
  watchApp: { packageName?: string };
  unwatchApp: EmptyCommandResult;
  playOnMicrophone: PlayOnMicrophoneResult;
  cameraControl: EmptyCommandResult;
  adbShell: AdbShellResultMessage;
  setWifiBandwidth: EmptyCommandResult;
  startRecording: EmptyCommandResult;
  stopRecording: EmptyCommandResult;
};

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * Creates a client for interacting with a Limbar instance
 * @param options Configuration options including webrtcUrl, token and log level
 * @returns An InstanceClient for controlling the instance
 */
export async function createInstanceClient(options: InstanceClientOptions): Promise<InstanceClient> {
  const endpointWebSocketUrl = deriveEndpointWebSocketUrl(options.apiUrl);
  const serverAddress = `${endpointWebSocketUrl}?token=${options.token}`;
  const recordingApiUrl = options.apiUrl;
  const logLevel = options.logLevel ?? 'info';
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  const reconnectDelay = options.reconnectDelay ?? 1000;
  const maxReconnectDelay = options.maxReconnectDelay ?? 30000;

  let ws: WebSocket | undefined = undefined;
  let connectionState: ConnectionState = 'connecting';
  let reconnectAttempts = 0;
  let reconnectTimeout: NodeJS.Timeout | undefined;
  let intentionalDisconnect = false;
  let lastError: string | undefined;
  const pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  const pendingAssetRequestsByUrl: Map<string, Array<PendingRequest<void>>> = new Map();
  // App exit callbacks are keyed by execId. They intentionally survive transient
  // WebSocket reconnects and are one-shot once a matching appExit is processed.
  const appExitCallbacks: Map<string, LaunchAppExitCallback> = new Map();

  const stateChangeCallbacks: Set<ConnectionStateCallback> = new Set();

  const logger = {
    debug: (...args: any[]) => {
      if (logLevel === 'debug') console.log('[Endpoint]', ...args);
    },
    info: (...args: any[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log('[Endpoint]', ...args);
    },
    warn: (...args: any[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug')
        console.warn('[Endpoint]', ...args);
    },
    error: (...args: any[]) => {
      if (logLevel !== 'none') console.error('[Endpoint]', ...args);
    },
  };

  const updateConnectionState = (newState: ConnectionState): void => {
    if (connectionState !== newState) {
      connectionState = newState;
      logger.debug(`Connection state changed to: ${newState}`);
      stateChangeCallbacks.forEach((callback) => {
        try {
          callback(newState);
        } catch (err) {
          logger.error('Error in connection state callback:', err);
        }
      });
    }
  };

  const failPendingRequests = (reason: string): void => {
    pendingRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    });
    pendingRequests.clear();
    pendingAssetRequestsByUrl.forEach((requests) => {
      requests.forEach((request) => {
        clearTimeout(request.timeout);
        request.reject(new Error(reason));
      });
    });
    pendingAssetRequestsByUrl.clear();
  };

  const cleanup = (): void => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = undefined;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = undefined;
    }
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = undefined;
    }
  };

  let pingInterval: NodeJS.Timeout | undefined;
  let requestCounter = 0;
  const keepAliveSessionId =
    Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  return new Promise<InstanceClient>((resolveConnection, rejectConnection) => {
    let hasResolved = false;

    const nextRequestId = (prefix: string): string => {
      requestCounter += 1;
      return `${prefix}-${Date.now()}-${requestCounter}`;
    };

    const resolvePendingRequest = <T>(id: string, value: T): void => {
      const request = pendingRequests.get(id) as PendingRequest<T> | undefined;
      if (!request) {
        logger.debug(`Received response for unknown/already-settled request: ${id}`);
        return;
      }
      clearTimeout(request.timeout);
      pendingRequests.delete(id);
      request.resolve(value);
    };

    const rejectPendingRequest = (id: string, error: Error): void => {
      const request = pendingRequests.get(id);
      if (!request) {
        logger.debug(`Received error for unknown/already-settled request: ${id}`);
        return;
      }
      clearTimeout(request.timeout);
      pendingRequests.delete(id);
      request.reject(error);
    };

    const extractErrorMessage = (message: ServerMessage): string | undefined => {
      if ('message' in message && typeof message.message === 'string') {
        return message.message;
      }
      // "Flat" results (e.g. cameraControlResult, playOnMicrophoneResult)
      // carry the error as a plain string instead of a CommandError object.
      if ('error' in message && typeof message.error === 'string' && message.error) {
        return message.error;
      }
      if ('error' in message && message.error && typeof message.error === 'object') {
        const obj = message.error as CommandError;
        if (typeof obj.message === 'string' && obj.message) {
          return obj.message;
        }
        if (typeof obj.code === 'string' && obj.code) {
          return obj.code;
        }
        // Presence of an error object itself is treated as failure, even if message/code are absent.
        return `Server returned ${String(message.type)} with an error payload but no error message/code`;
      }
      return undefined;
    };

    const isKnownCommandResultMessage = (message: ServerMessage): message is KnownCommandResultMessage => {
      if (!('type' in message) || typeof message.type !== 'string') {
        return false;
      }
      switch (message.type) {
        case 'screenshotResult':
        case 'getElementTreeResult':
        case 'findElementResult':
        case 'tapResult':
        case 'setTextResult':
        case 'pressKeyResult':
        case 'scrollScreenResult':
        case 'scrollElementResult':
        case 'openUrlResult':
        case 'launchAppResult':
        case 'terminateAppResult':
        case 'watchAppResult':
        case 'unwatchAppResult':
        case 'playOnMicrophoneResult':
        case 'cameraControlResult':
        case 'adbShellResult':
        case 'setWifiBandwidthResult':
        case 'startRecordingResult':
        case 'stopRecordingResult':
          return 'id' in message && typeof message.id === 'string';
        default:
          return false;
      }
    };

    const sendRequest = async <K extends keyof CommandRequestMap>(
      type: K,
      params: CommandRequestMap[K],
      timeoutMs: number = 30000,
    ): Promise<CommandResultMap[K]> => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected or connection is not open.'));
      }
      const id = nextRequestId('ts-client');
      const command =
        Object.keys(params).length > 0 ? { type, id, ...params, payload: params } : { type, id };
      return new Promise<CommandResultMap[K]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error(`Request ${type} timed out`));
          }
        }, timeoutMs);
        pendingRequests.set(id, {
          resolve: (value: unknown) => resolve(value as CommandResultMap[K]),
          reject: (reason: Error) => reject(reason),
          timeout,
        });
        ws!.send(JSON.stringify(command), (err?: Error) => {
          if (err) {
            clearTimeout(timeout);
            pendingRequests.delete(id);
            reject(err);
          }
        });
      });
    };

    // Reconnection logic with exponential backoff
    const scheduleReconnect = (): void => {
      if (intentionalDisconnect) {
        logger.debug('Skipping reconnection (intentional disconnect)');
        return;
      }

      if (isNonRetryableError(lastError ?? '')) {
        logger.debug('Skipping reconnection (non-retryable error)');
        return;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        logger.error(
          `Max reconnection attempts (${maxReconnectAttempts}) reached. Giving up.`,
          lastError ? `Last error: ${lastError}` : '',
        );
        updateConnectionState('disconnected');
        return;
      }

      const currentDelay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts), maxReconnectDelay);

      reconnectAttempts++;
      logger.debug(`Scheduling reconnection attempt ${reconnectAttempts} in ${currentDelay}ms...`);
      updateConnectionState('reconnecting');

      reconnectTimeout = setTimeout(() => {
        logger.debug(`Attempting to reconnect (attempt ${reconnectAttempts})...`);
        setupWebSocket();
      }, currentDelay);
    };

    const setupWebSocket = (): void => {
      cleanup();
      updateConnectionState('connecting');

      const proxyAgent = nodeProxyTransport.getWebSocketAgent(serverAddress);
      ws = new WebSocket(serverAddress, proxyAgent ? { agent: proxyAgent } : {});

      ws.on('message', (data: Data) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(data.toString());
        } catch (e) {
          logger.error({ data, error: e }, 'Failed to parse JSON message');
          return;
        }

        switch (message.type) {
          case 'screenshot': {
            if (!('dataUri' in message) || typeof message.dataUri !== 'string' || !('id' in message)) {
              logger.warn('Received invalid screenshot message:', message);
              break;
            }
            const screenshotMessage = message as ScreenshotResponse;
            logger.debug(`Received screenshot data URI for request ${screenshotMessage.id}.`);
            resolvePendingRequest<ScreenshotData>(screenshotMessage.id, {
              dataUri: screenshotMessage.dataUri,
            });
            break;
          }
          case 'appExit': {
            const exitMessage = message as AppExitMessage;
            const { execId, packageName, reason } = exitMessage;
            if (typeof execId !== 'string' || typeof packageName !== 'string' || typeof reason !== 'string') {
              logger.warn('Received malformed appExit message:', message);
              break;
            }
            const callback = appExitCallbacks.get(execId);
            if (!callback) {
              logger.debug(`Received appExit for unknown or already handled execId: ${execId}`);
              break;
            }
            appExitCallbacks.delete(execId);
            const logs = Array.isArray(exitMessage.logs) ? exitMessage.logs.map(String) : [];
            const info: AppExitInfo = {
              packageName,
              reason,
              ...(exitMessage.crash ? { crash: exitMessage.crash } : {}),
              ...(exitMessage.anr ? { anr: exitMessage.anr } : {}),
            };
            void Promise.resolve()
              .then(() => callback(logs, info))
              .catch((error) => {
                logger.error(`Error in onExit callback for execId ${execId}:`, error);
              });
            break;
          }
          case 'screenshotResult': {
            const resultMessage = message as ScreenshotResultMessage;
            const errorMessage = extractErrorMessage(resultMessage);
            if (errorMessage) {
              rejectPendingRequest(resultMessage.id, new Error(errorMessage));
              break;
            }
            const dataUri =
              typeof resultMessage.payload?.dataUri === 'string' ? resultMessage.payload.dataUri : '';
            if (!dataUri) {
              rejectPendingRequest(
                resultMessage.id,
                new Error('Received screenshotResult without payload.dataUri'),
              );
              break;
            }
            resolvePendingRequest<ScreenshotData>(resultMessage.id, { dataUri });
            break;
          }
          case 'screenshotError': {
            if (!('message' in message) || !('id' in message)) {
              logger.warn('Received invalid screenshot error message:', message);
              break;
            }
            const errorMessage = message as ScreenshotErrorResponse;
            logger.error(
              `Server reported an error capturing screenshot for request ${errorMessage.id}:`,
              errorMessage.message,
            );
            rejectPendingRequest(errorMessage.id, new Error(errorMessage.message));
            break;
          }
          case 'assetResult': {
            logger.debug('Received assetResult:', message);
            const url = message.url as string;
            const queue = pendingAssetRequestsByUrl.get(url);
            if (!queue || queue.length === 0) {
              logger.warn(`Received assetResult for unknown or already handled url: ${message.url}`);
              break;
            }
            const request = queue.shift()!;
            if (queue.length === 0) {
              pendingAssetRequestsByUrl.delete(url);
            } else {
              pendingAssetRequestsByUrl.set(url, queue);
            }
            clearTimeout(request.timeout);
            if (message.result === 'success') {
              logger.debug('Asset result is success');
              request.resolve();
              break;
            }
            const assetErrorMessage =
              typeof message.message === 'string' && message.message ?
                message.message
              : `Asset processing failed: ${JSON.stringify(message)}`;
            logger.debug('Asset result is failure', assetErrorMessage);
            request.reject(new Error(assetErrorMessage));
            break;
          }
          default: {
            if (isKnownCommandResultMessage(message)) {
              const err = extractErrorMessage(message);
              if (err) {
                rejectPendingRequest(message.id, new Error(err));
              } else {
                resolvePendingRequest(message.id, message.payload ?? message);
              }
              break;
            }
            logger.warn(`Received unexpected message type: ${message.type}`);
            break;
          }
        }
      });

      ws.on('error', (err: Error) => {
        const errMessage = err.message;
        lastError = errMessage;
        logger.debug('WebSocket error:', errMessage);
        if (!hasResolved && (ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN)) {
          rejectConnection(err);
        }
      });

      ws.on('close', () => {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = undefined;
        }

        const shouldReconnect =
          !intentionalDisconnect &&
          !isNonRetryableError(lastError ?? '') &&
          connectionState !== 'disconnected';
        updateConnectionState('disconnected');

        logger.debug('Disconnected from server.');

        failPendingRequests('Connection closed');

        if (shouldReconnect) {
          scheduleReconnect();
        } else if (isNonRetryableError(lastError ?? '')) {
          logger.error(`Closing connection due to non-retryable error: ${lastError}`);
          cleanup();
          updateConnectionState('disconnected');
          failPendingRequests('Non-retryable error');
          logger.debug('Non-retryable error. Closing connection.');
        }
      });

      ws.on('open', () => {
        logger.debug(`Connected to ${serverAddress}`);
        reconnectAttempts = 0;
        lastError = undefined;
        updateConnectionState('connected');

        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            (ws as any).ping();
          }
        }, 30_000);

        if (!hasResolved) {
          hasResolved = true;
          resolveConnection({
            screenshot,
            getElementTree,
            findElement,
            tap,
            setText,
            pressKey,
            scrollScreen,
            scrollElement,
            openUrl,
            launchApp,
            terminateApp,
            watchApp,
            playOnMicrophone,
            pushFile,
            pullFile,
            setCameraVideo,
            clearCameraVideo,
            adbShell,
            setWifiBandwidth,
            startRecording,
            stopRecording,
            keepAlive,
            disconnect,
            startAdbTunnel,
            startTunnel,
            getTunnelStatus,
            stopTunnel,
            sendAsset,
            syncApp,
            getConnectionState,
            onConnectionStateChange,
          });
        }
      });
    };

    const screenshot = async (): Promise<ScreenshotData> => {
      return sendRequest('screenshot', {});
    };

    const getElementTree = async (options?: AndroidElementTreeOptions): Promise<ElementTreeData> => {
      const result = await sendRequest(
        'getElementTree',
        options ?? {},
        30_000 + (options?.waitForIdleTimeoutMs ?? 0),
      );
      return {
        xml: typeof result.xml === 'string' ? result.xml : '',
        nodes: Array.isArray(result.nodes) ? result.nodes : [],
      };
    };

    const findElement = async (selector: AndroidSelector, limit = 20): Promise<FindElementResult> => {
      const result = await sendRequest('findElement', { selector, limit });
      const elements = Array.isArray(result.elements) ? result.elements : [];
      return {
        elements,
        count: typeof result.count === 'number' ? result.count : elements.length,
      };
    };

    const tap = async (target: AndroidElementTarget): Promise<TapResult> => {
      const result = await sendRequest('tap', target);
      return {
        x: Number(result.x ?? 0),
        y: Number(result.y ?? 0),
      };
    };

    const setText = async (
      target: AndroidElementTarget | undefined,
      text: string,
    ): Promise<SetTextResult> => {
      const payload: CommandRequestMap['setText'] = { text };
      if (target?.selector) payload.selector = target.selector;
      if (typeof target?.x === 'number') payload.x = target.x;
      if (typeof target?.y === 'number') payload.y = target.y;
      const result = await sendRequest('setText', payload);
      return {
        textLength: Number(result.textLength ?? text.length),
      };
    };

    const pressKey = async (key: string, modifiers?: string[]): Promise<PressKeyResult> => {
      const payload: CommandRequestMap['pressKey'] = {
        keyName: key,
        ...(modifiers ? { modifiers } : {}),
      };
      const result = await sendRequest('pressKey', payload);
      return {
        key: typeof result.key === 'string' ? result.key : String(key),
      };
    };

    const scrollScreen = async (direction: ScrollDirection, amount = 6): Promise<ScrollResult> => {
      const result = await sendRequest('scrollScreen', { direction, amount });
      return result;
    };

    const scrollElement = async (
      target: AndroidElementTarget,
      direction: ScrollDirection,
      amount = 6,
    ): Promise<ScrollResult> => {
      const result = await sendRequest('scrollElement', {
        ...target,
        direction,
        amount,
      });
      return result;
    };

    const openUrl = async (url: string): Promise<OpenUrlResult> => {
      const result = await sendRequest('openUrl', { url });
      return {
        url: typeof result.url === 'string' ? result.url : url,
      };
    };

    /**
     * Registers a one-shot exit callback under a fresh execId, runs the request that
     * carries it (launchApp or watchApp), and unregisters the callback if the request
     * fails so it can never fire for a watch the server never accepted.
     */
    const withExitCallback = async <T>(
      idPrefix: string,
      onExit: LaunchAppExitCallback,
      send: (execId: string) => Promise<T>,
    ): Promise<{ execId: string; result: T }> => {
      const execId = nextRequestId(idPrefix);
      appExitCallbacks.set(execId, onExit);
      try {
        return { execId, result: await send(execId) };
      } catch (error) {
        appExitCallbacks.delete(execId);
        throw error;
      }
    };

    const launchApp = async (
      packageName: string,
      launchOptions: LaunchAppOptions = {},
    ): Promise<LaunchAppResult> => {
      const sendLaunch = (execId?: string) => {
        const request: CommandRequestMap['launchApp'] = { packageName };
        if (launchOptions.mode) request.mode = launchOptions.mode;
        if (execId) request.execId = execId;
        return sendRequest('launchApp', request, 60_000);
      };
      const result =
        launchOptions.onExit ?
          (await withExitCallback('exec', launchOptions.onExit, sendLaunch)).result
        : await sendLaunch();
      return {
        packageName: typeof result.packageName === 'string' ? result.packageName : packageName,
      };
    };

    const terminateApp = async (packageName: string): Promise<void> => {
      await sendRequest('terminateApp', { packageName });
    };

    const watchApp = async (packageName: string, onExit: LaunchAppExitCallback): Promise<AppWatch> => {
      const { execId } = await withExitCallback('watch', onExit, (execId) =>
        sendRequest('watchApp', { packageName, execId }),
      );
      return {
        execId,
        stop: async () => {
          appExitCallbacks.delete(execId);
          await sendRequest('unwatchApp', { execId });
        },
      };
    };

    const playOnMicrophone = async (
      inputPath: string,
      microphoneOptions?: PlayOnMicrophoneOptions,
    ): Promise<PlayOnMicrophoneResult> => {
      if (!inputPath) {
        throw new Error('path must be a non-empty string');
      }
      return sendRequest('playOnMicrophone', {
        path: inputPath,
        ...(microphoneOptions?.once === undefined ? {} : { once: microphoneOptions.once }),
      });
    };

    const pushFile = async (filePath: string, destination?: string): Promise<string> => {
      const uploadUrl =
        destination === undefined ?
          `${options.apiUrl}/files`
        : `${options.apiUrl}/files?path=${encodeURIComponent(destination)}`;
      const fileStream = fs.createReadStream(filePath);
      // Node's fetch (undici) supports streaming request bodies but TS DOM types may not include
      // `duplex` and may not accept Node ReadStreams as BodyInit in some configs.
      const response = await nodeProxyTransport.fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fs.statSync(filePath).size.toString(),
          Authorization: `Bearer ${options.token}`,
        },
        body: fileStream as any,
        duplex: 'half' as any,
      } as any);
      if (!response.ok) {
        const errorBody = await response.text();
        logger.debug(`Upload failed: ${response.status} ${errorBody}`);
        throw new Error(`Upload failed: ${response.status} ${errorBody}`);
      }
      const result = (await response.json()) as { path: string };
      return result.path;
    };

    const pullFile = async (remotePath: string, localPath: string): Promise<void> => {
      const downloadUrl = `${options.apiUrl}/files?path=${encodeURIComponent(remotePath)}`;
      // Streams to disk without buffering the whole file in memory.
      await downloadFileToLocalPath(downloadUrl, options.token, localPath);
    };

    const setCameraVideo = async (filePath: string, cameraOptions?: CameraVideoOptions): Promise<void> => {
      const remotePath = await pushFile(filePath);
      await sendRequest('cameraControl', {
        action: 'setSource',
        source: 'video',
        arg: remotePath,
        loop: cameraOptions?.loop ?? true,
      });
    };

    const clearCameraVideo = async (): Promise<void> => {
      await sendRequest('cameraControl', { action: 'reset' });
    };

    const adbShell = async (
      command: string,
      args: string[] = [],
      adbOptions?: AdbShellOptions,
    ): Promise<AdbShellResult> => {
      if (!command) {
        throw new Error('command must be a non-empty string');
      }
      const commandLine = quoteShellArgs([command, ...args]);
      const timeoutMs = adbOptions?.timeoutMs;
      // Wait a little longer than the device-side timeout so the server's own
      // error surfaces instead of a generic client timeout.
      const requestTimeoutMs = (timeoutMs ?? 30000) + 15000;
      const result = await sendRequest(
        'adbShell',
        { command: commandLine, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
        requestTimeoutMs,
      );
      const encoding = adbOptions?.encoding ?? 'utf8';
      return {
        stdout: Buffer.from(result.stdout ?? '', 'base64').toString(encoding),
        stderr: Buffer.from(result.stderr ?? '', 'base64').toString(encoding),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
        truncated: result.truncated === true,
      };
    };

    const setWifiBandwidth = async (bandwidthOptions: WifiBandwidthOptions): Promise<void> => {
      const request: CommandRequestMap['setWifiBandwidth'] = {};
      if (bandwidthOptions.downKbps !== undefined) {
        assertBandwidthKbps('downKbps', bandwidthOptions.downKbps);
        request.downKbps = bandwidthOptions.downKbps;
      }
      if (bandwidthOptions.upKbps !== undefined) {
        assertBandwidthKbps('upKbps', bandwidthOptions.upKbps);
        request.upKbps = bandwidthOptions.upKbps;
      }
      if (request.downKbps === undefined && request.upKbps === undefined) {
        throw new Error('setWifiBandwidth requires downKbps, upKbps, or both');
      }
      await sendRequest('setWifiBandwidth', request);
    };

    const startRecording = async (recordingOptions?: { quality?: RecordingQuality }): Promise<void> => {
      const request: CommandRequestMap['startRecording'] = {};
      if (recordingOptions?.quality !== undefined) {
        if (
          !Number.isInteger(recordingOptions.quality) ||
          recordingOptions.quality < 5 ||
          recordingOptions.quality > 10
        ) {
          throw new Error('quality must be one of: 5, 6, 7, 8, 9, 10');
        }
        request.quality = recordingOptions.quality;
      }
      await sendRequest('startRecording', request);
    };

    const stopRecording = async (saveTo: { presignedUrl?: string; localPath?: string }): Promise<string> => {
      const request: CommandRequestMap['stopRecording'] = {};
      if (saveTo.presignedUrl) {
        request.upload = { presignedUrl: saveTo.presignedUrl };
      }
      await sendRequest('stopRecording', request);
      const downloadUrl = buildDownloadUrl(recordingApiUrl);
      if (saveTo.localPath) {
        await downloadFileToLocalPath(downloadUrl, options.token, saveTo.localPath);
      }
      return downloadUrl;
    };

    const keepAlive = (): void => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'keepAlive',
          sessionId: keepAliveSessionId,
        }),
      );
    };

    const disconnect = (): void => {
      intentionalDisconnect = true;
      cleanup();
      updateConnectionState('disconnected');
      failPendingRequests('Intentional disconnect');
      logger.debug('Intentionally disconnected from WebSocket.');
    };

    const getConnectionState = (): ConnectionState => {
      return connectionState;
    };

    const onConnectionStateChange = (callback: ConnectionStateCallback): (() => void) => {
      stateChangeCallbacks.add(callback);
      return () => {
        stateChangeCallbacks.delete(callback);
      };
    };

    /**
     * Opens a WebSocket TCP proxy for the ADB port and connects the local adb
     * client to it.
     */
    const startAdbTunnel = async (): Promise<Tunnel> => {
      if (!options.adbUrl) {
        throw new Error('adbUrl is required to start an ADB tunnel.');
      }
      const tunnel = await startTcpTunnel(options.adbUrl, options.token, '127.0.0.1', 0, {
        maxReconnectAttempts,
        reconnectDelay,
        maxReconnectDelay,
        logLevel,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            options.adbPath ?? 'adb',
            ['connect', `${tunnel.address.address}:${tunnel.address.port}`],
            (err) => {
              if (err) return reject(err);
              resolve();
            },
          );
        });
        logger.debug(`ADB connected on ${tunnel.address.address}`);
      } catch (err) {
        tunnel.close();
        throw err;
      }
      return tunnel;
    };

    const requireAdbUrl = (): string => {
      if (!options.adbUrl) {
        throw new Error('adbUrl is required to manage a destination tunnel.');
      }
      return options.adbUrl;
    };

    const startTunnel = async (tunnelOptions: DestinationTunnelOptions): Promise<DestinationTunnel> => {
      return startDestinationTcpTunnel(deriveDestinationTunnelURL(requireAdbUrl()), options.token, {
        ...(tunnelOptions.routes ? { routes: tunnelOptions.routes } : {}),
        ...(tunnelOptions.domains ? { domains: tunnelOptions.domains } : {}),
        ...(tunnelOptions.cidrs ? { cidrs: tunnelOptions.cidrs } : {}),
        window: tunnelOptions.window ?? ANDROID_TUNNEL_DEFAULT_WINDOW,
        logLevel: tunnelOptions.logLevel ?? logLevel,
      });
    };

    const getTunnelStatus = async (): Promise<DestinationTunnelStatus> => {
      return getDestinationTunnelStatus(requireAdbUrl(), options.token);
    };

    const stopTunnel = async (tunnelId: string): Promise<void> => {
      await stopDestinationTunnel(requireAdbUrl(), options.token, tunnelId);
    };

    const sendAsset = async (url: string, timeoutMs?: number): Promise<void> => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected or connection is not open.'));
      }
      const assetRequest: AssetRequest = {
        type: 'asset',
        url,
      };
      return new Promise<void>((resolve, reject) => {
        let request: PendingRequest<void>;
        const timeout = setTimeout(() => {
          const queue = pendingAssetRequestsByUrl.get(url);
          if (!queue) {
            return;
          }
          const idx = queue.indexOf(request);
          if (idx >= 0) {
            queue.splice(idx, 1);
            reject(new Error(`Request asset timed out for url: ${url}`));
          }
          if (queue.length === 0) {
            pendingAssetRequestsByUrl.delete(url);
          } else {
            pendingAssetRequestsByUrl.set(url, queue);
          }
        }, timeoutMs ?? 120_000);
        request = {
          resolve,
          reject: (reason: Error) => reject(reason),
          timeout,
        };
        const queue = pendingAssetRequestsByUrl.get(url) ?? [];
        queue.push(request);
        pendingAssetRequestsByUrl.set(url, queue);
        ws!.send(JSON.stringify(assetRequest), (err?: Error) => {
          if (err) {
            clearTimeout(timeout);
            const queued = pendingAssetRequestsByUrl.get(url) ?? [];
            const idx = queued.indexOf(request);
            if (idx >= 0) {
              queued.splice(idx, 1);
            }
            if (queued.length === 0) {
              pendingAssetRequestsByUrl.delete(url);
            } else {
              pendingAssetRequestsByUrl.set(url, queued);
            }
            logger.error('Failed to send asset request:', err);
            reject(err);
          }
        });
      });
    };

    const syncApp: InstanceClient['syncApp'] = async (apkPath, syncOpts) => {
      const resolvedPath = path.resolve(apkPath);
      await assertApkFile(resolvedPath);
      const fileName = path.basename(resolvedPath);
      const hash = crypto.createHash('sha1').update(resolvedPath).digest('hex').slice(0, 8);
      const cacheKey = `limsync-cache-android-${fileName}-${hash}`;
      const basisCacheDir = syncOpts?.basisCacheDir ?? path.join(os.tmpdir(), cacheKey);
      const syncLog: FolderSyncOptions['log'] = (level, msg) => {
        switch (level) {
          case 'debug':
            logger.debug(msg);
            break;
          case 'info':
            logger.info(msg);
            break;
          case 'warn':
            logger.warn(msg);
            break;
          case 'error':
            logger.error(msg);
            break;
          default:
            logger.info(msg);
        }
      };
      await fs.promises.mkdir(basisCacheDir, { recursive: true });
      await bootstrapAndroidBasisCache(
        resolvedPath,
        basisCacheDir,
        options.apiUrl,
        options.token,
        syncLog,
        syncOpts?.onBasisDownloadProgress,
      );
      return await syncFolder(resolvedPath, {
        apiUrl: options.apiUrl,
        token: options.token,
        udid: cacheKey,
        basisCacheDir,
        install: syncOpts?.install ?? true,
        launchMode: syncOpts?.launchMode ?? 'ForegroundIfRunning',
        watch: syncOpts?.watch ?? false,
        ignoreFn: () => false,
        log: syncLog,
        compression: 'identity',
        ...(syncOpts?.onSyncComplete ? { onSyncComplete: syncOpts.onSyncComplete } : {}),
      });
    };

    // Start the initial connection
    setupWebSocket();
  });
}
