import React, { useEffect, useRef, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { clsx } from 'clsx';
import './remote-control.css';

import { ANDROID_KEYS, AMOTION_EVENT, codeMap } from '../core/constants';

import iphoneFrameImage from '../assets/iphone16pro_black_bg.webp';
import pixelFrameImage from '../assets/pixel9_black.webp';
import pixelFrameImageLandscape from '../assets/pixel9_black_landscape.webp';
import pixelTabletFrameImage from '../assets/pixel_tablet_portrait.webp';
import pixelTabletFrameImageLandscape from '../assets/pixel_tablet_landscape.webp';
import iphoneFrameImageLandscape from '../assets/iphone16pro_black_landscape_bg.webp';
import appleLogoSvg from '../assets/Apple_logo_white.svg';
import androidBootImage from '../assets/android_boot.webp';
import {
  createTouchControlMessage,
  createInjectKeycodeMessage,
  createSetClipboardMessage,
  createTwoFingerTouchControlMessage,
} from '../core/webrtc-messages';
import { AxFetcher, AxStatus } from '../core/ax-fetcher';
import { AxElement, AxSnapshot, axElementAtPoint, axSnapshotsEqual } from '../core/ax-tree';
import { InspectOverlay, InspectOverlayGeometry, InspectMode } from './inspect-overlay';

declare global {
  interface Window {
    debugRemoteControl?: boolean;
  }
}

interface RemoteControlProps {
  // url is the URL of the instance to connect to.
  url: string;

  // token is used to authenticate the connection to the instance.
  token: string;

  // className is the class name to apply to the component
  // on top of the default styles.
  className?: string;

  // sessionId is a unique identifier for the WebRTC session
  // with the source to prevent conflicts between other
  // users connected to the same source.
  // If empty, the component will generate a random one.
  sessionId?: string;

  // openUrl is the URL to open in the instance when the
  // component is ready.
  //
  // If not provided, the component will not open any URL.
  openUrl?: string;

  // showFrame controls whether to display the device frame
  // around the video. Defaults to true.
  showFrame?: boolean;

  // When true, drops after a working session auto-reconnect instead of
  // surfacing the manual "Retry" button. Defaults to false.
  autoReconnect?: boolean;

  /**
   * Enable the inspect overlay. When set, the component starts polling the
   * accessibility tree and draws boxes over each element on top of the
   * video stream.
   *
   * - `true` — Select mode. Boxes are clickable, click pins a selection
   *   with action buttons (Tap / Copy selector / Copy id), ESC clears.
   *   Device input is blocked while in this mode.
   * - `'hover-only'` — Boxes follow the cursor as a visual preview. Device
   *   input still passes through, so you can drive the simulator while
   *   inspecting.
   * - `undefined` / `false` (default) — overlay disabled, no polling.
   */
  inspectMode?: boolean | 'hover-only';

  /**
   * Fires whenever a fresh accessibility snapshot is delivered.
   *
   * Customers use this to drive their own side panels, agent prompts,
   * analytics, etc. The built-in overlay does not require this callback —
   * it renders from internal state regardless.
   *
   * Identical-to-previous snapshots (per `axSnapshotsEqual`) are NOT
   * re-emitted, so a stable UI doesn't generate callback noise.
   *
   * Invoked in a microtask so customer code doesn't run synchronously
   * inside React's commit phase.
   */
  onAxSnapshotChange?: (snapshot: AxSnapshot | null) => void;

  /**
   * Fires when the user clicks an overlay element (only emitted when
   * `inspectMode === true`). `null` indicates a deselection (ESC, click
   * outside any box, or programmatic clear).
   *
   * The `snapshot` field is the snapshot active at the moment of the
   * click — useful for capturing context without races against the next
   * poll cycle.
   */
  onInspectSelectionChange?: (selection: { element: AxElement; snapshot: AxSnapshot } | null) => void;

  /**
   * Fires whenever the accessibility subsystem changes coarse-grained
   * status. Useful for rendering readiness indicators or error banners in
   * a customer-built side panel.
   *
   * Transitions are deduplicated; no self-loops are emitted. The `error`
   * argument is populated when status is `error` or `unavailable`.
   *
   * Lifecycle: `idle` → `starting` → `ready` (or `unavailable` / `error`).
   * Recovery from `error` / `unavailable` is automatic — the fetcher
   * keeps polling and transitions back to `ready` on the next success.
   */
  onAxStatusChange?: (status: AxStatus, error?: string) => void;

  /**
   * Base interval (ms) between successful AX-tree fetches.
   *
   * The fetcher will:
   * - Wait `axPollIntervalMs` after a successful fetch with NEW data.
   * - Double the wait (up to `axMaxBackoffMs`) when consecutive snapshots
   *   are byte-identical (e.g. static screen).
   * - Wait 5 s when the server reports AX is unavailable.
   *
   * In addition, after user input (taps, scrolls, keypresses, openUrl,
   * terminateApp, orientation flips), the fetcher enters a short
   * "activity boost" window (~1.2 s) during which fetches happen at
   * ~250 ms regardless of this setting. This captures mid-animation UI
   * changes without you having to manually call `refreshAxTree`.
   *
   * @default 500
   */
  axPollIntervalMs?: number;

  /**
   * Maximum backoff (ms) for the AX-tree polling loop when consecutive
   * snapshots are unchanged.
   *
   * @default 2000
   */
  axMaxBackoffMs?: number;

  /**
   * Fires whenever the iOS simulator's camera demand state changes —
   * i.e. an app inside the sim called
   * `[AVCaptureSession startRunning]` or `[stopRunning]`. The
   * component handles the `navigator.mediaDevices.getUserMedia` prompt
   * and SDP plumbing internally; this callback is purely so the host
   * UI can render a status indicator ("simulator is using your
   * camera", etc.).
   *
   * `active` reflects whether the sim is currently asking for
   * frames. `granted` is set only on the call that follows a
   * `getUserMedia` attempt: `true` when the user accepted the
   * browser prompt, `false` when they denied or the call failed
   * (in which case the limulator side switches to a black-frame
   * fallback so the app keeps ticking).
   *
   * `camera` (optional, only meaningful when `granted === true`)
   * carries what `MediaStreamTrack.getSettings()` reported for the
   * active capture: resolution, framerate, device label, facing
   * mode. Use it to render a richer status indicator (e.g.
   * "Camera · 1920×1080 · 30 fps · FaceTime HD").
   *
   * Only iOS instances ever fire this callback; Android instances
   * have no camera-injector path and stay silent.
   */
  onCameraDemandChange?: (active: boolean, granted?: boolean, camera?: CameraCaptureInfo) => void;

  /**
   * Periodically (~1Hz) fires with a snapshot of the outbound
   * camera stream's live WebRTC stats — codec, encoder
   * implementation, hardware acceleration, encoded fps, bitrate,
   * round-trip-time, and the encoder's
   * `qualityLimitationReason` (which is what Meet/Zoom use to
   * decide whether to show "Bandwidth limited" or "CPU limited"
   * banners).
   *
   * Only fires while the simulator is actively pulling the
   * camera AND `getUserMedia` was granted. `null` is emitted
   * once when the stream goes back to idle so consumers can
   * clear their UI without having to maintain their own
   * timeout. The host app does not need to poll `getStats()`
   * itself — this is the canonical place.
   */
  onCameraStats?: (stats: CameraStreamStats | null) => void;

  /**
   * Optional resolution cap for outbound camera capture.
   *
   * - `'auto'` (default): no extra constraint. The browser captures
   *   at its webcam's native max; WebRTC's quality scaler may step
   *   down resolution on the encoder side under bandwidth pressure
   *   while still feeding the simulator at the pool's native size.
   * - `'1080p'` / `'720p'` / `'480p'`: hard cap applied via
   *   `getUserMedia` constraints (for new captures) and
   *   `track.applyConstraints` (for the currently-active track),
   *   matching the way Meet/Zoom expose a "Send resolution" picker.
   *
   * Bumping or lowering the cap mid-stream is supported; the
   * change takes effect within a frame or two as the webcam
   * re-negotiates.
   */
  cameraResolutionCap?: CameraResolutionCap;
  /**
   * Aspect ratio the simulator's virtual camera should report to apps.
   * Picking a value here triggers a `cameraAspect` WS message to the
   * host, which rebuilds its IOSurface ring at the matching dimensions
   * (16:9 → 1920×1080, 4:3 → 1440×1080, 1:1 → 1080×1080, 9:16 →
   * 1080×1920) and signals the in-sim dylib to re-handshake. iOS apps
   * see CMSampleBuffers at the new dimensions within a frame or two.
   *
   * The browser still captures whatever the webcam offers; the host
   * aspect-fills (cover, center-crop) into the new pool. Switching
   * aspect at runtime is intentionally cheap so users can A/B preview
   * styles without restarting the simulator.
   *
   * `undefined` leaves the pool untouched (the host's boot default —
   * 16:9 / 1920×1080 — applies).
   */
  cameraAspect?: CameraAspect;
}

/**
 * Resolution caps a host app can request on the outbound camera.
 * `'auto'` is "let the browser decide" (no constraints beyond the
 * 30 fps ceiling); the other options clamp width/height to the
 * named target. Aspect ratio is preserved.
 */
export type CameraResolutionCap = 'auto' | '1080p' | '720p' | '480p';

/**
 * Aspect ratios exposed to the operator for the simulated camera.
 * The host maps each label to concrete IOSurface dimensions; values
 * the host doesn't recognise are silently ignored.
 */
export type CameraAspect = '16:9' | '4:3' | '1:1' | '9:16';

/**
 * Snapshot of the browser's webcam capture, mirrored from
 * `MediaStreamTrack.getSettings()`. Forwarded to the host alongside
 * `cameraResult` and exposed to the host app via
 * `onCameraDemandChange` so it can render a status indicator without
 * having to call `getStats()` itself.
 */
export interface CameraCaptureInfo {
  width?: number;
  height?: number;
  frameRate?: number;
  deviceId?: string;
  label?: string;
  facingMode?: string;
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

interface ScreenshotData {
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

export interface RemoteControlHandle {
  openUrl: (url: string) => void;
  sendKeyEvent: (event: ImperativeKeyboardEvent) => void;
  screenshot: () => Promise<ScreenshotData>;
  terminateApp: (bundleId: string) => Promise<void>;
  reconnect: () => void;

  // Inspect-mode helpers. These are no-ops when inspect mode is disabled or
  // the WebSocket isn't open.

  // Force a fresh accessibility-tree fetch outside the normal poll cadence.
  refreshAxTree: () => Promise<AxSnapshot>;

  // Pull-based access to the most recent snapshot (the same one passed to
  // onAxSnapshotChange). Returns null when no snapshot has arrived yet or
  // when inspect mode is off.
  getAxSnapshot: () => AxSnapshot | null;

  // Programmatically drive the overlay highlight/selection — useful when a
  // customer's own side panel wants to cross-highlight with the overlay.
  // Pass `null` to clear.
  setInspectHighlight: (element: AxElement | null) => void;
  setInspectSelection: (element: AxElement | null) => void;

  // Pull-based access to the current AX subsystem status. Mirrors what
  // onAxStatusChange reports, for customers that don't want to subscribe.
  getAxStatus: () => AxStatus;
}

const debugLog = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.log(...args);
  }
};

const debugWarn = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.warn(...args);
  }
};

// Invokes a customer-provided callback in isolation. A throw from the
// customer's code must NOT propagate back into our state-update flow — that
// would risk corrupting React reconciliation. We log the error to the
// console so the customer can still debug, but otherwise swallow.
const safeInvoke = <Args extends unknown[]>(
  label: string,
  fn: ((...args: Args) => unknown) | undefined,
  ...args: Args
): void => {
  if (!fn) return;
  try {
    fn(...args);
  } catch (err) {
    // Surface to the developer regardless of debug flag — this is a bug
    // in the customer's handler and they'll want to see it.
    // eslint-disable-next-line no-console
    console.error(`[RemoteControl] customer callback "${label}" threw:`, err);
  }
};

const motionActionToString = (action: number): string => {
  // AMOTION_EVENT is a constants object; find the matching ACTION_* key if present
  const match = Object.entries(AMOTION_EVENT).find(
    ([key, value]) => key.startsWith('ACTION_') && value === action,
  );
  return match?.[0] ?? String(action);
};

type DevicePlatform = 'ios' | 'android';

const detectPlatform = (url: string): DevicePlatform => {
  if (url.includes('/android_')) {
    return 'android';
  }
  // Default to iOS if no Android pattern is found
  return 'ios';
};

type DeviceConfig = {
  videoBorderRadiusMultiplier: number;
  loadingLogo: string;
  loadingLogoSize: string;
  videoPosition: {
    portrait: { heightMultiplier?: number; widthMultiplier?: number };
    landscape: { heightMultiplier?: number; widthMultiplier?: number };
  };
  frame: {
    image: string;
    imageLandscape: string;
  };
};

const ANDROID_TABLET_VIDEO_WIDTH = 1920;
const ANDROID_TABLET_VIDEO_HEIGHT = 1200;
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_RETRY_DELAY_MS = 1000;
const CONNECTION_SUCCESS_TIMEOUT_MS = 15000;
const ICE_DISCONNECTED_GRACE_MS = 3000;

const isAndroidTabletVideo = (width: number, height: number): boolean =>
  (width === ANDROID_TABLET_VIDEO_WIDTH && height === ANDROID_TABLET_VIDEO_HEIGHT) ||
  (width === ANDROID_TABLET_VIDEO_HEIGHT && height === ANDROID_TABLET_VIDEO_WIDTH);

// Device-specific configuration for frame sizing and video positioning
// Video position percentages are relative to the frame image dimensions
const deviceConfig: Record<DevicePlatform, DeviceConfig> = {
  ios: {
    frame: {
      image: iphoneFrameImage,
      imageLandscape: iphoneFrameImageLandscape,
    },
    videoBorderRadiusMultiplier: 0.15,
    loadingLogo: appleLogoSvg,
    loadingLogoSize: '20%',
    // Video position as percentage of frame dimensions
    videoPosition: {
      portrait: { heightMultiplier: 0.9678 },
      landscape: { widthMultiplier: 0.9678 },
    },
  },
  android: {
    frame: {
      image: pixelFrameImage,
      imageLandscape: pixelFrameImageLandscape,
    },
    videoBorderRadiusMultiplier: 0.13,
    loadingLogo: androidBootImage,
    loadingLogoSize: '40%',
    // Video position as percentage of frame dimensions
    videoPosition: {
      portrait: { heightMultiplier: 0.967 },
      landscape: { widthMultiplier: 0.962 },
    },
  },
};

function getAndroidKeycodeAndMeta(event: React.KeyboardEvent): { keycode: number; metaState: number } | null {
  const code = event.code;
  const keycode = codeMap[code];

  if (!keycode) {
    // Use the wrapper for conditional warning
    debugWarn(`Unknown event.code: ${code}, key: ${event.key}`);
    return null;
  }

  let metaState = ANDROID_KEYS.META_NONE;
  const isLetter = code >= 'KeyA' && code <= 'KeyZ';
  const isCapsLock = event.getModifierState('CapsLock');
  const isShiftPressed = event.shiftKey;

  // Determine effective shift state
  let effectiveShift = isShiftPressed;
  if (isLetter) {
    effectiveShift = isShiftPressed !== isCapsLock; // Logical XOR for booleans
  }

  // Apply meta states
  if (effectiveShift) metaState |= ANDROID_KEYS.META_SHIFT_ON;
  if (event.ctrlKey) metaState |= ANDROID_KEYS.META_CTRL_ON;
  if (event.altKey) metaState |= ANDROID_KEYS.META_ALT_ON;
  if (event.metaKey) metaState |= ANDROID_KEYS.META_META_ON; // Command on Mac, Windows key on Win

  return { keycode, metaState };
}

export const RemoteControl = forwardRef<RemoteControlHandle, RemoteControlProps>(
  (
    {
      className,
      url,
      token,
      sessionId: propSessionId,
      openUrl,
      showFrame = true,
      autoReconnect = false,
      inspectMode,
      onAxSnapshotChange,
      onInspectSelectionChange,
      onAxStatusChange,
      axPollIntervalMs,
      axMaxBackoffMs,
      onCameraDemandChange,
      onCameraStats,
      cameraResolutionCap = 'auto',
      cameraAspect,
    }: RemoteControlProps,
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const frameRef = useRef<HTMLImageElement>(null);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [retryExhausted, setRetryExhausted] = useState(false);
    const [isLandscape, setIsLandscape] = useState(false);
    const [useAndroidTabletFrame, setUseAndroidTabletFrame] = useState(false);
    const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({});
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const keepAliveIntervalRef = useRef<number | undefined>(undefined);
    const retryTimeoutRef = useRef<number | undefined>(undefined);
    const connectionSuccessTimeoutRef = useRef<number | undefined>(undefined);
    const requestFrameIntervalRef = useRef<number | undefined>(undefined);
    const iceDisconnectedGraceRef = useRef<number | undefined>(undefined);
    const connectionGenerationRef = useRef(0);
    const connectionAttemptRef = useRef(0);
    const controlChannelOpenedRef = useRef(false);
    // Mirrored to a ref so stale closures in event handlers see the latest value.
    const autoReconnectRef = useRef(autoReconnect);
    autoReconnectRef.current = autoReconnect;
    // Demand-driven outbound camera state.
    //
    // The limulator side broadcasts a `cameraRequest` WS message whenever
    // an app inside the simulator opens/closes an `AVCaptureSession`.
    // We respond by calling `navigator.mediaDevices.getUserMedia(...)`
    // and `replaceTrack`ing the result onto a pre-allocated sendonly
    // video transceiver. Pre-allocating the transceiver lets us
    // attach/detach the local camera without renegotiating the SDP
    // (the slot is already in the answer's a=video block, just with
    // `inactive`/empty until we install the track).
    //
    // Refs (not state) because all callers live inside event-handler
    // closures and the ref read happens during message processing, not
    // during render. We keep both the sender and the active local
    // stream so teardown can stop tracks without leaking the camera
    // green light.
    const outboundCameraSenderRef = useRef<RTCRtpSender | null>(null);
    const outboundLocalStreamRef = useRef<MediaStream | null>(null);
    // Bumped on every `cameraRequest` so a handler suspended on an
    // await (e.g. the getUserMedia prompt) can detect it was superseded
    // by a newer request and bail instead of re-attaching the camera.
    const cameraRequestGenerationRef = useRef(0);
    const cameraResolutionCapRef = useRef(cameraResolutionCap);
    cameraResolutionCapRef.current = cameraResolutionCap;
    // The aspect prop also rides a ref so the WS `onopen` reconnect
    // path can replay the operator's last pick without depending on
    // an in-flight render cycle. We mutate it inline (same render-
    // time pattern as the cap ref) so a parent prop change is visible
    // to closures captured during the next render; the useEffect
    // below handles the actual "send to host" side-effect.
    const cameraAspectRef = useRef<CameraAspect | undefined>(cameraAspect);
    cameraAspectRef.current = cameraAspect;
    // Mirror the demand-change callback into a ref so the WS message
    // handler always sees the freshest customer callback even when the
    // parent re-renders mid-session.
    const onCameraDemandChangeRef = useRef(onCameraDemandChange);
    onCameraDemandChangeRef.current = onCameraDemandChange;
    const onCameraStatsRef = useRef(onCameraStats);
    onCameraStatsRef.current = onCameraStats;
    // Active outbound-camera stats poller. While the camera is
    // sending we sample `RTCPeerConnection.getStats()` once per
    // second, derive deltas (bitrate, fps, packet loss) from the
    // previous sample, and push the result through `onCameraStats`.
    // Cleared on teardown so we never leak the timer.
    const cameraStatsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const cameraStatsPrevRef = useRef<{
      timestamp: number;
      framesEncoded?: number;
      bytesSent?: number;
      packetsSent?: number;
      packetsLost?: number;
    } | null>(null);
    const firstFrameShownRef = useRef(false);
    const pendingScreenshotResolversRef = useRef<
      Map<string, (value: ScreenshotData | PromiseLike<ScreenshotData>) => void>
    >(new Map());
    const pendingScreenshotRejectersRef = useRef<Map<string, (reason?: any) => void>>(new Map());
    const pendingTerminateAppResolversRef = useRef<Map<string, () => void>>(new Map());
    const pendingTerminateAppRejectersRef = useRef<Map<string, (reason?: any) => void>>(new Map());

    // Map to track active pointers for real touch/mouse single-finger events.
    // Key: pointerId (-1 for mouse, touch.identifier for touch), Value: { x: number, y: number }
    const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

    // Alt/Option modifier state for pinch emulation.
    // We use a ref as the source of truth (for synchronous event handler access)
    // and state only to trigger re-renders for the visual indicators.
    const isAltHeldRef = useRef(false);
    const [isAltHeld, setIsAltHeld] = useState(false);

    // State for any two-finger gesture (Alt+mouse simulated or real two-finger touch).
    // Tracks positions, video size, source, and pointer IDs (for Android protocol).
    type TwoFingerState = {
      finger0: { x: number; y: number };
      finger1: { x: number; y: number };
      videoSize: { width: number; height: number };
      // Track source so we know when to clear (Alt release vs touch end)
      source: 'alt-mouse' | 'real-touch';
      // Pointer IDs for Android (real touch.identifier or simulated -1/-2)
      pointerId0: number;
      pointerId1: number;
    };
    const twoFingerStateRef = useRef<TwoFingerState | null>(null);

    // Hover point for rendering two-finger indicators when Alt is held.
    // Only computed/set when Alt is held to avoid unnecessary re-renders.
    type HoverPoint = {
      containerX: number;
      containerY: number;
      mirrorContainerX: number;
      mirrorContainerY: number;
      videoX: number;
      videoY: number;
      mirrorVideoX: number;
      mirrorVideoY: number;
      videoWidth: number;
      videoHeight: number;
    };
    const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);

    // Inspect-mode state.
    //
    // Lifecycle of `axFetcherRef`:
    //   - Created in dataChannel.onopen (last step of WebRTC handshake)
    //     so we know the signaling WS is healthy and the device is
    //     responsive to control messages.
    //   - Started immediately if `inspectMode` is already enabled, or
    //     started later via the sibling useEffect when inspectMode flips on.
    //   - Stopped + nulled in teardownConnection (WS close / unmount).
    //
    // Customers can observe readiness via the `onAxStatusChange` callback:
    // `starting` fires when start() runs but no snapshot has landed yet;
    // `ready` once the first snapshot arrives. Status falls back to
    // `unavailable` / `error` if the server can't satisfy AX requests.
    const axFetcherRef = useRef<AxFetcher | null>(null);
    const [axSnapshot, setAxSnapshot] = useState<AxSnapshot | null>(null);
    const [axHighlightedId, setAxHighlightedId] = useState<string | null>(null);
    const [axSelectedId, setAxSelectedId] = useState<string | null>(null);
    const [overlayGeometry, setOverlayGeometry] = useState<InspectOverlayGeometry | null>(null);
    // Viewport-space cursor position used to anchor the inspect InfoCard.
    // Throttled to one update per animation frame to avoid React reconciling
    // on every native mousemove (~60–120Hz).
    const [axCursorPosition, setAxCursorPosition] = useState<{ x: number; y: number } | null>(null);
    const cursorPositionRef = useRef<{ x: number; y: number } | null>(null);
    const cursorRafIdRef = useRef<number | undefined>(undefined);
    const scheduleCursorFlush = (next: { x: number; y: number } | null) => {
      cursorPositionRef.current = next;
      if (cursorRafIdRef.current !== undefined) return;
      cursorRafIdRef.current = window.requestAnimationFrame(() => {
        cursorRafIdRef.current = undefined;
        setAxCursorPosition(cursorPositionRef.current);
      });
    };
    // Position captured at click-time so the InfoCard "freezes" near where
    // the user clicked, even as they move the cursor around afterward. The
    // action buttons (Tap / Copy) stay reachable because the card no longer
    // chases the cursor while the click target is the active selection.
    const [axFrozenCursorPosition, setAxFrozenCursorPosition] = useState<{
      x: number;
      y: number;
    } | null>(null);
    // Mirrors for synchronous access from event handlers without stale closures.
    const inspectModeRef = useRef<boolean | 'hover-only' | undefined>(inspectMode);
    inspectModeRef.current = inspectMode;
    const axSnapshotRef = useRef<AxSnapshot | null>(null);
    axSnapshotRef.current = axSnapshot;
    const onAxSnapshotChangeRef = useRef(onAxSnapshotChange);
    onAxSnapshotChangeRef.current = onAxSnapshotChange;
    const onInspectSelectionChangeRef = useRef(onInspectSelectionChange);
    onInspectSelectionChangeRef.current = onInspectSelectionChange;
    const onAxStatusChangeRef = useRef(onAxStatusChange);
    onAxStatusChangeRef.current = onAxStatusChange;

    const inspectActive = inspectMode === true || inspectMode === 'hover-only';
    const inspectModeResolved: InspectMode = inspectMode === 'hover-only' ? 'hover-only' : 'select';

    const sessionId = useMemo(
      () =>
        propSessionId ||
        Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
      [propSessionId],
    );

    const platform = useMemo(() => detectPlatform(url), [url]);
    const config = deviceConfig[platform];

    const updateStatus = (message: string) => {
      // Use the wrapper for conditional logging
      debugLog(message);
    };

    const sendBinaryControlMessage = (data: ArrayBuffer) => {
      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
        return;
      }
      dataChannelRef.current.send(data);
      // Any binary control message is an input event. Bump the AX poller so
      // we get a fresh snapshot quickly — the UI almost certainly changed.
      axFetcherRef.current?.bumpActivity();
    };

    // Pointer ID used by inspect-driven taps. Distinct from human pointers
    // (-1 mouse, -2 alt-mirror) and our touch identifiers so they never
    // interfere with an in-progress drag.
    const AX_TAP_POINTER_ID = -10;

    // Send a down+up tap at a viewport-space (clientX/Y) position. The point
    // is mapped through the current video letterbox geometry so the
    // simulator receives the correct in-stream coordinates regardless of
    // how the device frame is sized in the DOM.
    const sendTapAtClient = (clientX: number, clientY: number) => {
      const ctx = computeVideoMappingContext();
      if (!ctx) return;
      const geometry = mapClientPointToVideo(ctx, clientX, clientY);
      if (!geometry) return;
      const { videoX, videoY, videoWidth, videoHeight } = geometry;
      const down = createTouchControlMessage(
        AMOTION_EVENT.ACTION_DOWN,
        AX_TAP_POINTER_ID,
        videoWidth,
        videoHeight,
        videoX,
        videoY,
        1.0,
        AMOTION_EVENT.BUTTON_PRIMARY,
        AMOTION_EVENT.BUTTON_PRIMARY,
      );
      if (down) sendBinaryControlMessage(down);
      window.setTimeout(() => {
        const up = createTouchControlMessage(
          AMOTION_EVENT.ACTION_UP,
          AX_TAP_POINTER_ID,
          videoWidth,
          videoHeight,
          videoX,
          videoY,
          0,
          AMOTION_EVENT.BUTTON_PRIMARY,
          AMOTION_EVENT.BUTTON_PRIMARY,
        );
        if (up) sendBinaryControlMessage(up);
      }, 60);
    };

    // Center-of-bounds fallback for programmatic taps when there's no
    // user-aimed click position (e.g. customer calls `setInspectSelection`
    // followed by their own "tap selected" handler without forwarding a
    // pointer position). Maps the element's frame center through the AX
    // screen-coordinate space to viewport coords, then delegates to
    // sendTapAtClient.
    const sendTapAtElementCenter = (element: AxElement, snapshot: AxSnapshot) => {
      const ctx = computeVideoMappingContext();
      if (!ctx) return;
      if (snapshot.screen.width <= 0 || snapshot.screen.height <= 0) return;
      const cxAx = element.frame.x + element.frame.width / 2;
      const cyAx = element.frame.y + element.frame.height / 2;
      // AX screen-fraction → in-video pixel offset → viewport client coord.
      const inVideoX = (cxAx / snapshot.screen.width) * ctx.actualWidth;
      const inVideoY = (cyAx / snapshot.screen.height) * ctx.actualHeight;
      const clientX = ctx.videoRect.left + ctx.offsetX + inVideoX;
      const clientY = ctx.videoRect.top + ctx.offsetY + inVideoY;
      sendTapAtClient(clientX, clientY);
    };

    // Fixed pointer IDs for Alt-simulated two-finger gestures
    const ALT_POINTER_ID_PRIMARY = -1;
    const ALT_POINTER_ID_MIRROR = -2;

    // Helper to send a single-touch control message (used by both single-finger and Android two-finger paths)
    const sendSingleTouch = (
      action: number,
      pointerId: number,
      videoWidth: number,
      videoHeight: number,
      x: number,
      y: number,
    ) => {
      const message = createTouchControlMessage(
        action,
        pointerId,
        videoWidth,
        videoHeight,
        x,
        y,
        1.0, // pressure
        AMOTION_EVENT.BUTTON_PRIMARY,
        AMOTION_EVENT.BUTTON_PRIMARY,
      );
      if (message) {
        debugLog('[rc-touch] sendSingleTouch', {
          action,
          actionName: motionActionToString(action),
          pointerId,
          x,
          y,
          video: { width: videoWidth, height: videoHeight },
        });
        sendBinaryControlMessage(message);
      }
    };

    // Minimal geometry for single-finger touch events (no mirror/container coords needed).
    type PointerGeometry = {
      videoX: number;
      videoY: number;
      videoWidth: number;
      videoHeight: number;
    };

    const applyPointerEvent = (
      pointerId: number,
      eventType: 'down' | 'move' | 'up' | 'cancel',
      geometry: PointerGeometry | null,
    ) => {
      if (!geometry) return;
      const { videoX, videoY, videoWidth, videoHeight } = geometry;

      let action: number | null = null;
      let positionToSend: { x: number; y: number } | null = null;
      let pressure = 1.0; // Default pressure
      const buttons = AMOTION_EVENT.BUTTON_PRIMARY; // Assume primary button

      switch (eventType) {
        case 'down':
          // For multi-touch: use ACTION_DOWN for first pointer, ACTION_POINTER_DOWN for additional pointers
          const currentPointerCount = activePointers.current.size;
          action = currentPointerCount === 0 ? AMOTION_EVENT.ACTION_DOWN : AMOTION_EVENT.ACTION_POINTER_DOWN;
          positionToSend = { x: videoX, y: videoY };
          activePointers.current.set(pointerId, positionToSend);
          if (pointerId === -1) {
            // Focus on mouse down
            videoRef.current?.focus();
          }
          break;

        case 'move':
          if (activePointers.current.has(pointerId)) {
            action = AMOTION_EVENT.ACTION_MOVE;
            positionToSend = { x: videoX, y: videoY };
            // Update the last known position for this active pointer
            activePointers.current.set(pointerId, positionToSend);
          }
          break;

        case 'up':
        case 'cancel': // Treat cancel like up, but use ACTION_CANCEL
          if (activePointers.current.has(pointerId)) {
            // IMPORTANT: Send the UP/CANCEL at the *last known position* inside the video
            positionToSend = activePointers.current.get(pointerId)!;
            activePointers.current.delete(pointerId); // Remove pointer as it's no longer active

            if (eventType === 'cancel') {
              action = AMOTION_EVENT.ACTION_CANCEL;
            } else {
              // For multi-touch: use ACTION_UP for last pointer, ACTION_POINTER_UP for non-last pointers
              const remainingPointerCount = activePointers.current.size;
              action =
                remainingPointerCount === 0 ? AMOTION_EVENT.ACTION_UP : AMOTION_EVENT.ACTION_POINTER_UP;
            }
          }
          break;
      }

      // Send message if action and position determined
      if (action !== null && positionToSend !== null) {
        debugLog('[rc-touch][mouse->touch] sending', {
          pointerId,
          eventType,
          action,
          actionName: motionActionToString(action),
          positionToSend,
          video: { width: videoWidth, height: videoHeight },
          altHeld: isAltHeldRef.current,
          activePointersAfter: Array.from(activePointers.current.entries()).map(([id, pos]) => ({
            id,
            x: pos.x,
            y: pos.y,
          })),
        });
        const message = createTouchControlMessage(
          action,
          pointerId,
          videoWidth,
          videoHeight,
          positionToSend.x,
          positionToSend.y,
          pressure,
          buttons,
          buttons,
        );
        if (message) {
          debugLog('[rc-touch][mouse->touch] buffer', {
            pointerId,
            actionName: motionActionToString(action),
            byteLength: message.byteLength,
          });
          sendBinaryControlMessage(message);
        }
      } else if (eventType === 'up' || eventType === 'cancel') {
        activePointers.current.delete(pointerId);
      }
    };

    // Update Alt modifier state. Only iOS Simulator uses Indigo modifier injection.
    const updateAltHeld = (nextHeld: boolean) => {
      if (isAltHeldRef.current === nextHeld) {
        return;
      }
      isAltHeldRef.current = nextHeld;
      setIsAltHeld(nextHeld);

      // Clear hover point when Alt is released to hide indicators immediately.
      if (!nextHeld) {
        setHoverPoint(null);
      }

      debugLog('[rc-touch][alt] updateAltHeld', {
        nextHeld,
        activePointerIds: Array.from(activePointers.current.keys()),
      });

      // iOS Simulator pinch (Option/Alt+drag) behavior depends on the Option modifier being
      // active on the Indigo HID side. Send Alt key down/up immediately on toggle so the
      // sequence matches Simulator.app (Alt down -> mouse down/drag -> mouse up -> Alt up).
      // This is iOS-specific; Android doesn't use this modifier injection.
      if (platform === 'ios' && dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
        const action = nextHeld ? ANDROID_KEYS.ACTION_DOWN : ANDROID_KEYS.ACTION_UP;
        const message = createInjectKeycodeMessage(
          action,
          ANDROID_KEYS.KEYCODE_ALT_LEFT,
          0,
          ANDROID_KEYS.META_NONE,
        );
        debugLog('[rc-touch][alt] sending Indigo modifier keycode', {
          action,
          keycode: ANDROID_KEYS.KEYCODE_ALT_LEFT,
        });
        if (message) {
          sendBinaryControlMessage(message);
        }
      }
    };

    // Mapping context computed once per DOM event, then reused for each pointer.
    type VideoMappingContext = {
      videoWidth: number;
      videoHeight: number;
      videoRect: DOMRect;
      containerRect: DOMRect;
      actualWidth: number;
      actualHeight: number;
      offsetX: number;
      offsetY: number;
    };

    // Compute mapping context from current video/container state (once per event).
    const computeVideoMappingContext = (): VideoMappingContext | null => {
      const video = videoRef.current;
      const container = containerRef.current;
      if (!video || !container) return null;

      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      if (!videoWidth || !videoHeight) return null;

      const videoRect = video.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      const displayWidth = videoRect.width;
      const displayHeight = videoRect.height;
      const videoAspectRatio = videoWidth / videoHeight;
      const containerAspectRatio = displayWidth / displayHeight;

      let actualWidth = displayWidth;
      let actualHeight = displayHeight;
      if (videoAspectRatio > containerAspectRatio) {
        actualHeight = displayWidth / videoAspectRatio;
      } else {
        actualWidth = displayHeight * videoAspectRatio;
      }

      const offsetX = (displayWidth - actualWidth) / 2;
      const offsetY = (displayHeight - actualHeight) / 2;

      return {
        videoWidth,
        videoHeight,
        videoRect,
        containerRect,
        actualWidth,
        actualHeight,
        offsetX,
        offsetY,
      };
    };

    // Map a client point to video coordinates using a pre-computed context,
    // clamping points outside the rendered video to the nearest point on the video.
    const mapClientPointToVideo = (
      ctx: VideoMappingContext,
      clientX: number,
      clientY: number,
    ): PointerGeometry | null => {
      const relativeX = clientX - ctx.videoRect.left - ctx.offsetX;
      const relativeY = clientY - ctx.videoRect.top - ctx.offsetY;

      const clampedRelativeX = Math.max(0, Math.min(ctx.actualWidth, relativeX));
      const clampedRelativeY = Math.max(0, Math.min(ctx.actualHeight, relativeY));
      const videoX = Math.max(
        0,
        Math.min(ctx.videoWidth, (clampedRelativeX / ctx.actualWidth) * ctx.videoWidth),
      );
      const videoY = Math.max(
        0,
        Math.min(ctx.videoHeight, (clampedRelativeY / ctx.actualHeight) * ctx.videoHeight),
      );

      return {
        videoX,
        videoY,
        videoWidth: ctx.videoWidth,
        videoHeight: ctx.videoHeight,
      };
    };

    // Compute full hover point with mirror/container coordinates (for Alt indicator rendering),
    // clamping points outside the rendered video to the nearest point on the video.
    const computeFullHoverPoint = (
      ctx: VideoMappingContext,
      clientX: number,
      clientY: number,
    ): HoverPoint | null => {
      const relativeX = clientX - ctx.videoRect.left - ctx.offsetX;
      const relativeY = clientY - ctx.videoRect.top - ctx.offsetY;

      const clampedRelativeX = Math.max(0, Math.min(ctx.actualWidth, relativeX));
      const clampedRelativeY = Math.max(0, Math.min(ctx.actualHeight, relativeY));
      const videoX = Math.max(
        0,
        Math.min(ctx.videoWidth, (clampedRelativeX / ctx.actualWidth) * ctx.videoWidth),
      );
      const videoY = Math.max(
        0,
        Math.min(ctx.videoHeight, (clampedRelativeY / ctx.actualHeight) * ctx.videoHeight),
      );
      const mirrorVideoX = ctx.videoWidth - videoX;
      const mirrorVideoY = ctx.videoHeight - videoY;

      const contentLeft = ctx.videoRect.left + ctx.offsetX;
      const contentTop = ctx.videoRect.top + ctx.offsetY;
      const containerX = contentLeft - ctx.containerRect.left + clampedRelativeX;
      const containerY = contentTop - ctx.containerRect.top + clampedRelativeY;
      const mirrorContainerX = contentLeft - ctx.containerRect.left + (ctx.actualWidth - clampedRelativeX);
      const mirrorContainerY = contentTop - ctx.containerRect.top + (ctx.actualHeight - clampedRelativeY);

      return {
        containerX,
        containerY,
        mirrorContainerX,
        mirrorContainerY,
        videoX,
        videoY,
        mirrorVideoX,
        mirrorVideoY,
        videoWidth: ctx.videoWidth,
        videoHeight: ctx.videoHeight,
      };
    };

    // Helper to send a two-finger touch message (iOS-specific type=18 message).
    const sendTwoFingerMessage = (
      action: number,
      videoWidth: number,
      videoHeight: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ) => {
      const msg = createTwoFingerTouchControlMessage(action, videoWidth, videoHeight, x0, y0, x1, y1);
      debugLog('[rc-touch2] sendTwoFingerMessage (iOS)', {
        actionName: motionActionToString(action),
        video: { width: videoWidth, height: videoHeight },
        p0: { x: x0, y: y0 },
        p1: { x: x1, y: y1 },
        byteLength: msg.byteLength,
      });
      sendBinaryControlMessage(msg);
    };

    // Generic two-finger event handler - sends platform-appropriate messages.
    // iOS: uses special two-finger message (type=18)
    // Android: sends two separate single-touch messages with proper action sequencing
    const applyTwoFingerEvent = (
      eventType: 'down' | 'move' | 'up',
      videoWidth: number,
      videoHeight: number,
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      pointerId0: number,
      pointerId1: number,
    ) => {
      debugLog('[rc-touch2] applyTwoFingerEvent', {
        platform,
        eventType,
        video: { width: videoWidth, height: videoHeight },
        p0: { x: x0, y: y0, id: pointerId0 },
        p1: { x: x1, y: y1, id: pointerId1 },
      });

      if (platform === 'ios') {
        // iOS: use special two-finger message (type=18)
        const action =
          eventType === 'down' ? AMOTION_EVENT.ACTION_DOWN
          : eventType === 'move' ? AMOTION_EVENT.ACTION_MOVE
          : AMOTION_EVENT.ACTION_UP;
        sendTwoFingerMessage(action, videoWidth, videoHeight, x0, y0, x1, y1);
      } else {
        // Android: send two separate single-touch messages with proper action codes
        // Per scrcpy protocol, each finger is a separate INJECT_TOUCH_EVENT with unique pointerId
        if (eventType === 'down') {
          // First finger down (ACTION_DOWN), then second finger down (ACTION_POINTER_DOWN)
          sendSingleTouch(AMOTION_EVENT.ACTION_DOWN, pointerId0, videoWidth, videoHeight, x0, y0);
          sendSingleTouch(AMOTION_EVENT.ACTION_POINTER_DOWN, pointerId1, videoWidth, videoHeight, x1, y1);
        } else if (eventType === 'move') {
          // Both fingers move (ACTION_MOVE for each)
          sendSingleTouch(AMOTION_EVENT.ACTION_MOVE, pointerId0, videoWidth, videoHeight, x0, y0);
          sendSingleTouch(AMOTION_EVENT.ACTION_MOVE, pointerId1, videoWidth, videoHeight, x1, y1);
        } else {
          // Second finger up (ACTION_POINTER_UP), then first finger up (ACTION_UP)
          sendSingleTouch(AMOTION_EVENT.ACTION_POINTER_UP, pointerId1, videoWidth, videoHeight, x1, y1);
          sendSingleTouch(AMOTION_EVENT.ACTION_UP, pointerId0, videoWidth, videoHeight, x0, y0);
        }
      }
    };

    // Update hover point only when Alt is held (to avoid re-renders in normal path).
    const updateHoverPoint = (ctx: VideoMappingContext, clientX: number, clientY: number) => {
      if (!isAltHeldRef.current) {
        // Don't compute or update when Alt isn't held
        if (hoverPoint !== null) {
          setHoverPoint(null);
        }
        return;
      }
      const fullPoint = computeFullHoverPoint(ctx, clientX, clientY);
      setHoverPoint(fullPoint);
    };

    // Map clientX/Y to AX screen-coordinate space using the latest snapshot.
    // Returns null if there's no snapshot or the click is outside the video.
    const hitTestAxAtClient = (
      ctx: VideoMappingContext,
      clientX: number,
      clientY: number,
    ): AxElement | null => {
      const snapshot = axSnapshotRef.current;
      if (!snapshot || snapshot.screen.width <= 0 || snapshot.screen.height <= 0) return null;
      const relX = clientX - ctx.videoRect.left - ctx.offsetX;
      const relY = clientY - ctx.videoRect.top - ctx.offsetY;
      if (relX < 0 || relY < 0 || relX > ctx.actualWidth || relY > ctx.actualHeight) return null;
      const axX = (relX / ctx.actualWidth) * snapshot.screen.width;
      const axY = (relY / ctx.actualHeight) * snapshot.screen.height;
      return axElementAtPoint(snapshot, axX, axY);
    };

    // Unified handler for both mouse and touch interactions
    const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();

      // Compute mapping context once per event (reused for all pointers)
      const ctx = computeVideoMappingContext();

      // Inspect-mode handling.
      //
      // We use JS hit-testing (not box-level onMouseEnter/Leave) as the
      // single source of truth for which element is under the cursor — it
      // handles overlapping rectangles deterministically by picking the
      // smallest matching box. The overlay's InspectBox children no longer
      // attach hover handlers; they just paint themselves based on the
      // `highlightedId` prop driven from here.
      //
      // Cursor position is tracked in both modes so the cursor-anchored
      // InfoCard can follow the pointer.
      const isInspecting = inspectModeRef.current === true || inspectModeRef.current === 'hover-only';
      if (isInspecting && !('touches' in event)) {
        if (event.type === 'mousemove') {
          scheduleCursorFlush({ x: event.clientX, y: event.clientY });
          if (ctx) {
            const hit = hitTestAxAtClient(ctx, event.clientX, event.clientY);
            setAxHighlightedId(hit?.id ?? null);
          }
        } else if (event.type === 'mouseleave') {
          scheduleCursorFlush(null);
          setAxHighlightedId(null);
        }
      }
      // Select mode blocks device input — clicks/drags don't reach the
      // simulator. Hover-only mode falls through to the regular path.
      if (inspectModeRef.current === true) {
        return;
      }

      // Handle hover point updates for mouse events (only when Alt is held)
      if (!('touches' in event) && ctx) {
        if (event.type === 'mousemove') {
          updateHoverPoint(ctx, event.clientX, event.clientY);
        } else if (event.type === 'mouseleave') {
          setHoverPoint(null);
        }
        // Note: Alt state is tracked via global keydown/keyup listeners, not event.altKey,
        // to ensure consistent behavior across focus transitions.
      }

      if (
        !dataChannelRef.current ||
        dataChannelRef.current.readyState !== 'open' ||
        !videoRef.current ||
        !ctx
      ) {
        return;
      }

      // --- Event Type Handling ---

      if ('touches' in event) {
        // Touch Events - handle both single-finger and two-finger gestures
        const allTouches = event.touches; // All currently active touches
        const changedTouches = event.changedTouches;

        let eventType: 'down' | 'move' | 'up' | 'cancel';
        switch (event.type) {
          case 'touchstart':
            eventType = 'down';
            break;
          case 'touchmove':
            eventType = 'move';
            break;
          case 'touchend':
            eventType = 'up';
            break;
          case 'touchcancel':
            eventType = 'cancel';
            break;
          default:
            return;
        }

        // Check if we have exactly 2 active touches - route to two-finger logic
        if (allTouches.length === 2) {
          const t0 = allTouches[0];
          const t1 = allTouches[1];
          const g0 = mapClientPointToVideo(ctx, t0.clientX, t0.clientY);
          const g1 = mapClientPointToVideo(ctx, t1.clientX, t1.clientY);

          if (!g0 || !g1) return;

          if (!twoFingerStateRef.current) {
            // Starting a new two-finger gesture
            twoFingerStateRef.current = {
              finger0: { x: g0.videoX, y: g0.videoY },
              finger1: { x: g1.videoX, y: g1.videoY },
              videoSize: { width: g0.videoWidth, height: g0.videoHeight },
              source: 'real-touch',
              pointerId0: t0.identifier,
              pointerId1: t1.identifier,
            };
            applyTwoFingerEvent(
              'down',
              g0.videoWidth,
              g0.videoHeight,
              g0.videoX,
              g0.videoY,
              g1.videoX,
              g1.videoY,
              t0.identifier,
              t1.identifier,
            );
          } else if (twoFingerStateRef.current.source === 'real-touch') {
            // Continuing two-finger gesture (move)
            twoFingerStateRef.current.finger0 = { x: g0.videoX, y: g0.videoY };
            twoFingerStateRef.current.finger1 = { x: g1.videoX, y: g1.videoY };
            applyTwoFingerEvent(
              'move',
              g0.videoWidth,
              g0.videoHeight,
              g0.videoX,
              g0.videoY,
              g1.videoX,
              g1.videoY,
              twoFingerStateRef.current.pointerId0,
              twoFingerStateRef.current.pointerId1,
            );
          }
        } else if (allTouches.length < 2 && twoFingerStateRef.current?.source === 'real-touch') {
          // Finger lifted - end two-finger gesture using last known state
          const state = twoFingerStateRef.current;
          applyTwoFingerEvent(
            'up',
            state.videoSize.width,
            state.videoSize.height,
            state.finger0.x,
            state.finger0.y,
            state.finger1.x,
            state.finger1.y,
            state.pointerId0,
            state.pointerId1,
          );
          twoFingerStateRef.current = null;
          // Don't process remaining finger - gesture ended
          return;
        } else if (allTouches.length > 2) {
          // 3+ fingers - not supported, ignore
          return;
        } else {
          // Single finger touch (allTouches is 0 or 1)
          // Note: allTouches=0 happens on touchend when last finger lifts
          const touch = changedTouches[0];
          if (touch) {
            const geometry = mapClientPointToVideo(ctx, touch.clientX, touch.clientY);
            applyPointerEvent(touch.identifier, eventType, geometry);
          }
        }
      } else {
        // Mouse Events
        const pointerId = -1; // Primary mouse pointer
        let eventType: 'down' | 'move' | 'up' | 'cancel' | null = null;

        // Determine if we're in two-finger mode (Alt+mouse drag)
        const inTwoFingerMode = twoFingerStateRef.current?.source === 'alt-mouse';

        switch (event.type) {
          case 'mousedown':
            if (event.button === 0) eventType = 'down';
            break;
          case 'mousemove':
            // Process move if either in two-finger mode or has active pointer (normal drag)
            if (inTwoFingerMode || activePointers.current.has(pointerId)) {
              eventType = 'move';
            }
            break;
          case 'mouseup':
            if (event.button === 0) eventType = 'up';
            break;
          case 'mouseleave':
            // Treat leave like up only if in drag/two-finger mode
            if (inTwoFingerMode || activePointers.current.has(pointerId)) {
              eventType = 'up';
            }
            break;
        }

        if (eventType) {
          const geometry = mapClientPointToVideo(ctx, event.clientX, event.clientY);
          if (!geometry) {
            return;
          }

          debugLog('[rc-touch][mouse] event', {
            domType: event.type,
            eventType,
            button: event.button,
            buttons: (event as React.MouseEvent).buttons,
            client: { x: event.clientX, y: event.clientY },
            altHeldRef: isAltHeldRef.current,
            inTwoFingerMode,
            geometry: {
              videoX: geometry.videoX,
              videoY: geometry.videoY,
              videoWidth: geometry.videoWidth,
              videoHeight: geometry.videoHeight,
            },
            activePointerIds: Array.from(activePointers.current.keys()),
          });

          // Route to two-finger (Alt+mouse) or single-finger path
          if (isAltHeldRef.current || inTwoFingerMode) {
            // Two-finger mode - Alt simulates second finger at mirror position
            handleAltMouseGesture(eventType, geometry);
          } else {
            // Normal single-finger touch
            applyPointerEvent(pointerId, eventType, geometry);
          }
        }
      }
    };

    // Handle Alt+mouse gestures (simulated two-finger with mirror position).
    // Works on both iOS and Android - applyTwoFingerEvent handles platform differences.
    const handleAltMouseGesture = (
      eventType: 'down' | 'move' | 'up' | 'cancel',
      geometry: PointerGeometry,
    ) => {
      const { videoX, videoY, videoWidth, videoHeight } = geometry;
      const mirrorX = videoWidth - videoX;
      const mirrorY = videoHeight - videoY;

      if (eventType === 'down') {
        // Start two-finger gesture
        twoFingerStateRef.current = {
          finger0: { x: videoX, y: videoY },
          finger1: { x: mirrorX, y: mirrorY },
          videoSize: { width: videoWidth, height: videoHeight },
          source: 'alt-mouse',
          pointerId0: ALT_POINTER_ID_PRIMARY,
          pointerId1: ALT_POINTER_ID_MIRROR,
        };
        videoRef.current?.focus();
        applyTwoFingerEvent(
          'down',
          videoWidth,
          videoHeight,
          videoX,
          videoY,
          mirrorX,
          mirrorY,
          ALT_POINTER_ID_PRIMARY,
          ALT_POINTER_ID_MIRROR,
        );
        return;
      }

      if (eventType === 'move') {
        if (twoFingerStateRef.current?.source === 'alt-mouse') {
          // Update positions
          twoFingerStateRef.current.finger0 = { x: videoX, y: videoY };
          twoFingerStateRef.current.finger1 = { x: mirrorX, y: mirrorY };
          applyTwoFingerEvent(
            'move',
            videoWidth,
            videoHeight,
            videoX,
            videoY,
            mirrorX,
            mirrorY,
            ALT_POINTER_ID_PRIMARY,
            ALT_POINTER_ID_MIRROR,
          );
        }
        return;
      }

      if (eventType === 'up' || eventType === 'cancel') {
        const state = twoFingerStateRef.current;
        if (state?.source === 'alt-mouse') {
          // End gesture at last known positions
          const { finger0, finger1, videoSize } = state;
          applyTwoFingerEvent(
            'up',
            videoSize.width,
            videoSize.height,
            finger0.x,
            finger0.y,
            finger1.x,
            finger1.y,
            ALT_POINTER_ID_PRIMARY,
            ALT_POINTER_ID_MIRROR,
          );
          twoFingerStateRef.current = null;
        }
        return;
      }
    };

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
          updateAltHeld(true);
        }
      };
      const handleKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Alt') {
          updateAltHeld(false);
        }
      };
      const handleWindowBlur = () => {
        updateAltHeld(false);
      };
      // Use capture phase so these fire before handleKeyboard's stopPropagation
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('keyup', handleKeyUp, true);
      window.addEventListener('blur', handleWindowBlur);
      return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('keyup', handleKeyUp, true);
        window.removeEventListener('blur', handleWindowBlur);
      };
    }, []);

    const handleKeyboard = (event: React.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Use the wrapper for conditional logging
      debugLog('Keyboard event:', {
        type: event.type,
        key: event.key,
        keyCode: event.keyCode,
        code: event.code,
        target: (event.target as HTMLElement).tagName,
        focused: document.activeElement === videoRef.current,
      });

      if (document.activeElement !== videoRef.current) {
        // Use the wrapper for conditional warning
        debugWarn('Video element not focused, skipping keyboard event');
        return;
      }

      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
        // Use the wrapper for conditional warning
        debugWarn('Data channel not ready for keyboard event:', dataChannelRef.current?.readyState);
        return;
      }

      // Handle special shortcuts first (Paste, Menu)
      if (event.type === 'keydown') {
        // Paste (Cmd+V / Ctrl+V)
        if (event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey)) {
          debugLog('Paste shortcut detected');
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) {
                debugLog(
                  'Pasting text via SET_CLIPBOARD:',
                  text.substring(0, 20) + (text.length > 20 ? '...' : ''),
                );
                const message = createSetClipboardMessage(text, true); // paste=true
                sendBinaryControlMessage(message);
              }
            })
            .catch((err) => {
              console.error('Failed to read clipboard contents: ', err);
            });
          return; // Don't process 'v' keycode further
        }

        // Menu (Cmd+M / Ctrl+M) - Send down and up immediately
        if (event.key.toLowerCase() === 'm' && (event.metaKey || event.ctrlKey)) {
          debugLog('Menu shortcut detected');
          const messageDown = createInjectKeycodeMessage(
            ANDROID_KEYS.ACTION_DOWN,
            ANDROID_KEYS.MENU,
            0,
            ANDROID_KEYS.META_NONE, // Modifiers are handled by the shortcut check, not passed down
          );
          sendBinaryControlMessage(messageDown);
          const messageUp = createInjectKeycodeMessage(
            ANDROID_KEYS.ACTION_UP,
            ANDROID_KEYS.MENU,
            0,
            ANDROID_KEYS.META_NONE,
          );
          sendBinaryControlMessage(messageUp);
          return; // Don't process 'm' keycode further
        }
      }

      // Handle general key presses (including Arrows, Enter, Backspace, Delete, Letters, Numbers, Symbols)
      const keyInfo = getAndroidKeycodeAndMeta(event);

      if (keyInfo) {
        const { keycode, metaState } = keyInfo;
        const action = event.type === 'keydown' ? ANDROID_KEYS.ACTION_DOWN : ANDROID_KEYS.ACTION_UP;

        debugLog(`Sending Keycode: key=${event.key}, code=${keycode}, action=${action}, meta=${metaState}`);

        const message = createInjectKeycodeMessage(
          action,
          keycode,
          0, // repeat count, typically 0 for single presses
          metaState,
        );
        sendBinaryControlMessage(message);
      } else {
        debugLog(`Ignoring unhandled key event: type=${event.type}, key=${event.key}`);
      }
    };

    const sendKeepAlive = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'keepAlive',
            sessionId: sessionId,
          }),
        );
      }
    };

    const startKeepAlive = () => {
      if (keepAliveIntervalRef.current) {
        window.clearInterval(keepAliveIntervalRef.current);
      }
      keepAliveIntervalRef.current = window.setInterval(sendKeepAlive, 10000);
    };

    const stopKeepAlive = () => {
      if (keepAliveIntervalRef.current) {
        window.clearInterval(keepAliveIntervalRef.current);
        keepAliveIntervalRef.current = undefined;
      }
    };

    const clearScheduledRetry = () => {
      if (retryTimeoutRef.current) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = undefined;
      }
    };

    const clearConnectionSuccessTimeout = () => {
      if (connectionSuccessTimeoutRef.current) {
        window.clearTimeout(connectionSuccessTimeoutRef.current);
        connectionSuccessTimeoutRef.current = undefined;
      }
    };

    const stopRequestFrameLoop = () => {
      if (requestFrameIntervalRef.current) {
        window.clearInterval(requestFrameIntervalRef.current);
        requestFrameIntervalRef.current = undefined;
      }
    };

    const clearIceDisconnectedGrace = () => {
      if (iceDisconnectedGraceRef.current !== undefined) {
        window.clearTimeout(iceDisconnectedGraceRef.current);
        iceDisconnectedGraceRef.current = undefined;
      }
    };

    const markFirstFrameShown = () => {
      if (firstFrameShownRef.current) {
        return;
      }
      firstFrameShownRef.current = true;
      stopRequestFrameLoop();
      setVideoLoaded(true);
    };

    // Stop every track on a MediaStream and release the device handle.
    // The browser keeps the camera "on" indicator lit until at least
    // one track on the underlying source is stopped, so we have to
    // call stop() explicitly — closing the peer connection alone
    // won't do it.
    const stopMediaStream = (stream: MediaStream) => {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch (err) {
          debugWarn('track.stop() failed:', err);
        }
      }
    };

    // Stop and forget any currently-attached outbound camera stream.
    // Safe to call when nothing is attached. Does not touch the
    // sender — the caller is responsible for `replaceTrack(null)`
    // separately when it wants the SDP slot itself empty.
    const stopOutboundLocalStream = () => {
      const stream = outboundLocalStreamRef.current;
      if (!stream) return;
      outboundLocalStreamRef.current = null;
      stopMediaStream(stream);
    };

    // Translate the user-facing resolution cap into a
    // MediaTrackConstraints fragment we can feed `getUserMedia`
    // or `applyConstraints`. Always returns a 30 fps ceiling so
    // a 60 fps webcam doesn't double our encoder cost for no
    // visible win (the simulator pool is paced at 30).
    //
    // We use `ideal` rather than `max` so that a webcam with a
    // native 720p mode still hands us 720p when the user picks
    // 1080p — instead of refusing the constraint outright. The
    // browser's NotReadableError on a too-strict `max` is the
    // most common camera-permission gotcha in the wild.
    const cameraCapToConstraints = (cap: CameraResolutionCap): MediaTrackConstraints => {
      const base: MediaTrackConstraints = {
        frameRate: { ideal: 30, max: 30 },
      };
      switch (cap) {
        case '1080p':
          return { ...base, width: { ideal: 1920 }, height: { ideal: 1080 } };
        case '720p':
          return { ...base, width: { ideal: 1280 }, height: { ideal: 720 } };
        case '480p':
          return { ...base, width: { ideal: 854 }, height: { ideal: 480 } };
        case 'auto':
        default:
          return base;
      }
    };

    // Convert the codec mime type (e.g. "video/H264" or "video/HEVC")
    // into a short uppercase label suitable for a status badge.
    const shortenCodecMime = (mime: string | undefined): string | undefined => {
      if (!mime) return undefined;
      const slash = mime.indexOf('/');
      const tail = slash >= 0 ? mime.slice(slash + 1) : mime;
      const upper = tail.toUpperCase();
      if (upper === 'HEVC') return 'H265';
      return upper;
    };

    // Sample outbound-camera stats once and push a normalised
    // snapshot through `onCameraStats`. Skips silently if the sender
    // has been torn down between intervals.
    const sampleOutboundCameraStats = async () => {
      const sender = outboundCameraSenderRef.current;
      const handler = onCameraStatsRef.current;
      if (!sender || !handler) return;
      let report: RTCStatsReport;
      try {
        report = await sender.getStats();
      } catch {
        return;
      }
      let outbound: any | undefined;
      let codecMime: string | undefined;
      let remoteInbound: any | undefined;
      report.forEach((entry: any) => {
        if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
          outbound = entry;
        } else if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video') {
          remoteInbound = entry;
        }
      });
      if (outbound?.codecId) {
        const codec = report.get(outbound.codecId);
        if (codec) codecMime = (codec as any).mimeType;
      }
      if (!outbound) return;
      const now = (outbound.timestamp as number) ?? Date.now();
      const prev = cameraStatsPrevRef.current;
      let fps: number | undefined;
      let bitrate: number | undefined;
      let lossPct: number | undefined;
      if (prev && now > prev.timestamp) {
        const dt = (now - prev.timestamp) / 1000;
        if (typeof outbound.framesEncoded === 'number' && typeof prev.framesEncoded === 'number') {
          fps = Math.max(0, (outbound.framesEncoded - prev.framesEncoded) / dt);
        }
        if (typeof outbound.bytesSent === 'number' && typeof prev.bytesSent === 'number') {
          bitrate = Math.max(0, ((outbound.bytesSent - prev.bytesSent) * 8) / dt);
        }
        if (
          typeof outbound.packetsSent === 'number' &&
          typeof prev.packetsSent === 'number' &&
          remoteInbound &&
          typeof remoteInbound.packetsLost === 'number' &&
          typeof prev.packetsLost === 'number'
        ) {
          const sent = outbound.packetsSent - prev.packetsSent;
          const lost = remoteInbound.packetsLost - prev.packetsLost;
          if (sent > 0) lossPct = Math.max(0, Math.min(100, (lost / sent) * 100));
        }
      }
      cameraStatsPrevRef.current = {
        timestamp: now,
        framesEncoded: outbound.framesEncoded,
        bytesSent: outbound.bytesSent,
        packetsSent: outbound.packetsSent,
        packetsLost: remoteInbound?.packetsLost,
      };
      const stats: CameraStreamStats = {
        codec: shortenCodecMime(codecMime),
        encoderImplementation: outbound.encoderImplementation,
        hardwareAccelerated:
          typeof outbound.powerEfficientEncoder === 'boolean' ? outbound.powerEfficientEncoder : undefined,
        framesPerSecond: fps,
        framesEncoded: outbound.framesEncoded,
        bitrateBps: bitrate,
        width: outbound.frameWidth,
        height: outbound.frameHeight,
        qualityLimitationReason: outbound.qualityLimitationReason,
        rttMs:
          typeof remoteInbound?.roundTripTime === 'number' ? remoteInbound.roundTripTime * 1000 : undefined,
        packetsLostPct: lossPct,
      };
      safeInvoke('onCameraStats', onCameraStatsRef.current, stats);
    };

    const startCameraStatsPoller = () => {
      if (cameraStatsTimerRef.current !== null) return;
      cameraStatsPrevRef.current = null;
      // First sample fires after one interval — the very first
      // sample has no deltas to compare against, which is fine: the
      // codec/encoder identity is still useful on its own.
      cameraStatsTimerRef.current = setInterval(() => {
        void sampleOutboundCameraStats();
      }, 1000);
    };

    const stopCameraStatsPoller = () => {
      if (cameraStatsTimerRef.current !== null) {
        clearInterval(cameraStatsTimerRef.current);
        cameraStatsTimerRef.current = null;
      }
      cameraStatsPrevRef.current = null;
      safeInvoke('onCameraStats', onCameraStatsRef.current, null);
    };

    const teardownConnection = () => {
      clearConnectionSuccessTimeout();
      clearIceDisconnectedGrace();
      stopRequestFrameLoop();
      if (axFetcherRef.current) {
        axFetcherRef.current.stop();
        axFetcherRef.current = null;
      }
      // Drop any active outbound camera before the PC dies so the
      // browser doesn't leave the camera indicator lit between
      // reconnects.
      stopCameraStatsPoller();
      stopOutboundLocalStream();
      outboundCameraSenderRef.current = null;
      // A scheduled cursor flush would otherwise call setState on a
      // teardown component once the next frame runs.
      if (cursorRafIdRef.current !== undefined) {
        window.cancelAnimationFrame(cursorRafIdRef.current);
        cursorRafIdRef.current = undefined;
      }
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.onconnectionstatechange = null;
        peerConnectionRef.current.oniceconnectionstatechange = null;
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (dataChannelRef.current) {
        dataChannelRef.current.onopen = null;
        dataChannelRef.current.onclose = null;
        dataChannelRef.current.onerror = null;
        dataChannelRef.current.close();
        dataChannelRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopKeepAlive();
      } else {
        startKeepAlive();
      }
    };

    const scheduleRetry = (reason: string, generation: number) => {
      if (generation !== connectionGenerationRef.current) {
        return;
      }

      if (controlChannelOpenedRef.current) {
        if (!autoReconnectRef.current) {
          updateStatus(`Connection failed after it was established: ${reason}`);
          setRetryExhausted(true);
          teardownConnection();
          return;
        }
        // Reset so the upcoming retry gets a fresh MAX_CONNECTION_ATTEMPTS budget.
        updateStatus(`Reconnecting after established session dropped: ${reason}`);
        controlChannelOpenedRef.current = false;
        connectionAttemptRef.current = -1;
      }

      clearScheduledRetry();

      const nextAttempt = connectionAttemptRef.current + 1;
      if (nextAttempt >= MAX_CONNECTION_ATTEMPTS) {
        updateStatus(`Connection failed after ${MAX_CONNECTION_ATTEMPTS} attempts: ${reason}`);
        setRetryExhausted(true);
        teardownConnection();
        return;
      }

      updateStatus(`Retrying connection (${nextAttempt + 1}/${MAX_CONNECTION_ATTEMPTS})`);
      teardownConnection();
      retryTimeoutRef.current = window.setTimeout(() => {
        retryTimeoutRef.current = undefined;
        if (generation !== connectionGenerationRef.current) {
          return;
        }
        void startAttempt(nextAttempt);
      }, CONNECTION_RETRY_DELAY_MS);
    };

    const startAttempt = async (attemptNumber = 0) => {
      const generation = connectionGenerationRef.current + 1;
      connectionGenerationRef.current = generation;
      connectionAttemptRef.current = attemptNumber;
      controlChannelOpenedRef.current = false;
      setRetryExhausted(false);
      clearScheduledRetry();
      clearConnectionSuccessTimeout();
      stopRequestFrameLoop();
      firstFrameShownRef.current = false;
      setVideoLoaded(false);
      teardownConnection();

      const isCurrentAttempt = () => generation === connectionGenerationRef.current;

      connectionSuccessTimeoutRef.current = window.setTimeout(() => {
        connectionSuccessTimeoutRef.current = undefined;
        if (!isCurrentAttempt() || controlChannelOpenedRef.current) {
          return;
        }
        scheduleRetry('Connection did not succeed within 15 seconds', generation);
      }, CONNECTION_SUCCESS_TIMEOUT_MS);

      try {
        const ws = new WebSocket(`${url}?token=${token}`);
        wsRef.current = ws;

        // Wait for WebSocket to connect
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timeoutId = window.setTimeout(() => reject(new Error('WebSocket connection timeout')), 30000);
          const settle = (callback: () => void) => {
            if (settled) {
              return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            callback();
          };

          ws.onopen = () => {
            if (!isCurrentAttempt() || wsRef.current !== ws) {
              return;
            }
            // Replay the saved camera aspect for fresh connections
            // (initial mount, autoreconnect, sim reboot). The host's
            // streamer starts at its boot default (16:9 / 1920×1080)
            // and a missing message would mean the operator's pick
            // silently reverts on reconnect. We always send something
            // when the prop is set, even if it matches the host
            // default — the host short-circuits no-op rebuilds.
            const initialAspect = cameraAspectRef.current;
            if (initialAspect) {
              try {
                ws.send(JSON.stringify({ type: 'cameraAspect', aspect: initialAspect }));
              } catch (err) {
                debugWarn('initial cameraAspect send failed:', err);
              }
            }
            settle(resolve);
          };

          ws.onerror = (error) => {
            if (!isCurrentAttempt() || wsRef.current !== ws) {
              return;
            }
            updateStatus('WebSocket error: ' + error);
            settle(() => reject(new Error('WebSocket connection failed')));
          };

          ws.onclose = () => {
            if (!isCurrentAttempt() || wsRef.current !== ws) {
              return;
            }
            updateStatus('WebSocket closed');
            settle(() => reject(new Error('WebSocket closed before connection was established')));
          };
        });
        if (!isCurrentAttempt() || wsRef.current !== ws) {
          return;
        }

        ws.onerror = (error) => {
          if (!isCurrentAttempt() || wsRef.current !== ws) {
            return;
          }
          updateStatus('WebSocket error: ' + error);
        };

        ws.onclose = () => {
          if (!isCurrentAttempt() || wsRef.current !== ws) {
            return;
          }
          updateStatus('WebSocket closed');
        };

        // Request RTCConfiguration
        const rtcConfigPromise = new Promise<RTCConfiguration>((resolve, reject) => {
          const timeoutId = window.setTimeout(() => reject(new Error('RTCConfiguration timeout')), 30000);

          const messageHandler = (event: MessageEvent) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'rtcConfiguration') {
                window.clearTimeout(timeoutId);
                ws.removeEventListener('message', messageHandler);
                resolve(message.rtcConfiguration);
              }
            } catch (e) {
              window.clearTimeout(timeoutId);
              ws.removeEventListener('message', messageHandler);
              console.error('Error handling RTC configuration:', e);
              reject(e);
            }
          };

          ws.addEventListener('message', messageHandler);
          ws.send(
            JSON.stringify({
              type: 'requestRtcConfiguration',
              sessionId: sessionId,
            }),
          );
        });

        const rtcConfig = await rtcConfigPromise;
        if (!isCurrentAttempt() || wsRef.current !== ws) {
          return;
        }

        const peerConnection = new RTCPeerConnection(rtcConfig);
        peerConnectionRef.current = peerConnection;
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });
        const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });

        // Pre-allocate a sendonly video slot for the user's camera.
        // The track stays `null` until the limulator side asks for one
        // (via the `cameraRequest` WS message), at which point we call
        // `replaceTrack` with a `getUserMedia` result. Allocating
        // up-front means we don't have to renegotiate the SDP when the
        // simulator app actually opens its `AVCaptureSession` — the
        // codec/SSRC negotiation happens once, here, and turning the
        // camera on/off later is just a track-replace.
        const outboundCameraTransceiver = peerConnection.addTransceiver('video', {
          direction: 'sendonly',
        });
        outboundCameraSenderRef.current = outboundCameraTransceiver.sender;

        // As hardware encoder, we use H265 for iOS and VP9 for Android.
        // We make sure these two are the first ones in the list.
        // If not, the fallback is H264 which is also hardware accelerated, although not as good,
        // available on all platforms.
        //
        // The rest is not important.
        if (RTCRtpReceiver.getCapabilities) {
          const capabilities = RTCRtpReceiver.getCapabilities('video');
          if (capabilities && capabilities.codecs) {
            const codecs = capabilities.codecs;
            const sortedCodecs = codecs.sort((a, b) => {
              const getCodecPriority = (codec: { mimeType: string }): number => {
                const mimeType = codec.mimeType.toLowerCase();
                if (mimeType.includes('vp9')) return 1;
                if (mimeType.includes('h265') || mimeType.includes('hevc')) return 2;
                if (mimeType.includes('h264') || mimeType.includes('avc')) return 3;
                return 4; // Everything else
              };
              return getCodecPriority(a) - getCodecPriority(b);
            });
            videoTransceiver.setCodecPreferences(sortedCodecs);
            debugLog('Set codec preferences:', sortedCodecs.map((c) => c.mimeType).join(', '));
          }
        }

        // Pin the outbound camera transceiver's codec order with
        // negotiation-time fallback. Preference order:
        //   1. H.265 / HEVC  — VideoToolbox HW on M-series + recent
        //      Chrome. ~30% less bitrate at equal quality. If the
        //      answerer (limulator) supports HEVC, this wins.
        //   2. H.264 with VideoToolbox-friendly profile-level-ids
        //      (42e01f / 42e028 / 640c1f). Universally HW-accelerated
        //      on every Mac since 2009. SDP-time fallback when HEVC
        //      isn't in the answer.
        //   3. Any other H.264 profile. Often resolves to OpenH264
        //      (software) so we keep it explicitly last among H.264
        //      to avoid Chrome's default pick.
        //   4. VP9 / VP8 (libvpx software on Mac). Last resort.
        //
        // Caveat: this is *negotiation* fallback. If HEVC HW encoder
        // init fails at session start or gets demoted mid-stream,
        // Chrome falls back to *software* HEVC, not H.264 — no spec
        // hook for runtime re-negotiation. The host-side stats
        // logger will surface this as decoder=ffmpeg / hw=false.
        if (RTCRtpSender.getCapabilities) {
          const senderCaps = RTCRtpSender.getCapabilities('video');
          if (senderCaps && senderCaps.codecs) {
            const vtH264Profiles = new Set(['42e01f', '42e028', '640c1f']);
            const score = (c: { mimeType: string; sdpFmtpLine?: string }): number => {
              const mime = c.mimeType.toLowerCase();
              const fmtp = (c.sdpFmtpLine || '').toLowerCase();
              const profileMatch = fmtp.match(/profile-level-id=([0-9a-f]{6})/);
              const profile = profileMatch ? profileMatch[1] : '';
              if (mime === 'video/h265' || mime === 'video/hevc') return 1;
              if (mime === 'video/h264' && vtH264Profiles.has(profile)) return 2;
              if (mime === 'video/h264') return 3;
              if (mime === 'video/vp9') return 4;
              if (mime === 'video/vp8') return 5;
              if (mime === 'video/rtx' || mime === 'video/red' || mime === 'video/ulpfec') {
                return 0; // Keep RTX/FEC available alongside everything else.
              }
              return 6;
            };
            const sortedSendCodecs = [...senderCaps.codecs].sort((a, b) => score(a) - score(b));
            try {
              outboundCameraTransceiver.setCodecPreferences(sortedSendCodecs);
              debugLog(
                'Outbound camera codec preferences:',
                sortedSendCodecs
                  .map((c) => `${c.mimeType}${c.sdpFmtpLine ? `[${c.sdpFmtpLine}]` : ''}`)
                  .join(', '),
              );
            } catch (err) {
              debugWarn('Failed to set outbound camera codec preferences:', err);
            }
          }
        }

        const dataChannel = peerConnection.createDataChannel('control', {
          ordered: true,
          negotiated: true,
          id: 1,
        });
        dataChannelRef.current = dataChannel;

        dataChannel.onopen = () => {
          if (!isCurrentAttempt() || dataChannelRef.current !== dataChannel || wsRef.current !== ws) {
            return;
          }
          controlChannelOpenedRef.current = true;
          clearConnectionSuccessTimeout();
          updateStatus('Control channel opened');

          // Spin up the AX fetcher now that we have a stable WS + control
          // channel. The fetcher's send function reuses this WS; it stops
          // sending if the WS dies. start() is called lazily based on the
          // inspectMode prop via a sibling useEffect.
          if (!axFetcherRef.current) {
            axFetcherRef.current = new AxFetcher({
              platform,
              baseIntervalMs: axPollIntervalMs,
              maxBackoffMs: axMaxBackoffMs,
              send: (payload) => {
                if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;
                try {
                  wsRef.current.send(JSON.stringify(payload));
                  return true;
                } catch {
                  return false;
                }
              },
              onSnapshot: (snapshot) => {
                setAxSnapshot((prev) => (axSnapshotsEqual(prev, snapshot) ? prev : snapshot));
                // Defer to a microtask so customer code (which may DOM-write,
                // start expensive work, or itself call back into ref
                // methods) doesn't run synchronously inside our state-setter
                // path. React then has a chance to schedule its render before
                // the customer handler kicks off side-effects.
                queueMicrotask(() => {
                  safeInvoke('onAxSnapshotChange', onAxSnapshotChangeRef.current, snapshot);
                });
              },
              onStatusChange: (status, error) => {
                safeInvoke('onAxStatusChange', onAxStatusChangeRef.current, status, error);
              },
            });
            if (inspectModeRef.current === true || inspectModeRef.current === 'hover-only') {
              axFetcherRef.current.start();
            }
          }
          const sendRequestFrame = () => {
            if (
              !isCurrentAttempt() ||
              firstFrameShownRef.current ||
              dataChannelRef.current !== dataChannel ||
              wsRef.current !== ws ||
              ws.readyState !== WebSocket.OPEN
            ) {
              return;
            }
            ws.send(JSON.stringify({ type: 'requestFrame', sessionId: sessionId }));
          };

          sendRequestFrame();
          stopRequestFrameLoop();
          requestFrameIntervalRef.current = window.setInterval(() => {
            if (
              !isCurrentAttempt() ||
              firstFrameShownRef.current ||
              dataChannelRef.current !== dataChannel ||
              wsRef.current !== ws ||
              ws.readyState !== WebSocket.OPEN
            ) {
              stopRequestFrameLoop();
              return;
            }
            sendRequestFrame();
          }, 250);

          // Send openUrl message if the prop is provided
          if (openUrl) {
            try {
              const decodedUrl = decodeURIComponent(openUrl);
              updateStatus('Opening URL');
              ws.send(
                JSON.stringify({
                  type: 'openUrl',
                  url: decodedUrl,
                  sessionId: sessionId,
                }),
              );
            } catch (error) {
              console.error({ error }, 'Error decoding URL, falling back to the original URL');
              ws.send(
                JSON.stringify({
                  type: 'openUrl',
                  url: openUrl,
                  sessionId: sessionId,
                }),
              );
            }
            // openUrl can take a moment to load the destination — boost
            // AX polling so the overlay refreshes through the transition.
            axFetcherRef.current?.bumpActivity();
          }
        };

        dataChannel.onclose = () => {
          if (!isCurrentAttempt() || dataChannelRef.current !== dataChannel) {
            return;
          }
          updateStatus('Control channel closed');
        };

        dataChannel.onerror = (error) => {
          if (!isCurrentAttempt() || dataChannelRef.current !== dataChannel) {
            return;
          }
          console.error('Control channel error:', error);
          updateStatus('Control channel error: ' + error);
        };

        // Set up connection state monitoring
        peerConnection.onconnectionstatechange = () => {
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
            return;
          }
          updateStatus('Connection state: ' + peerConnection.connectionState);
          if (peerConnection.connectionState === 'failed') {
            scheduleRetry('WebRTC connection entered failed state', generation);
          }
        };

        peerConnection.oniceconnectionstatechange = () => {
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
            return;
          }
          const iceState = peerConnection.iceConnectionState;
          updateStatus('ICE state: ' + iceState);
          if (iceState === 'connected' || iceState === 'completed') {
            clearIceDisconnectedGrace();
            return;
          }
          if (iceState === 'failed') {
            clearIceDisconnectedGrace();
            scheduleRetry('ICE connection entered failed state', generation);
            return;
          }
          if (
            iceState === 'disconnected' &&
            autoReconnectRef.current &&
            iceDisconnectedGraceRef.current === undefined
          ) {
            // Cap the browser's natural disconnected→failed escalation to recover faster.
            iceDisconnectedGraceRef.current = window.setTimeout(() => {
              iceDisconnectedGraceRef.current = undefined;
              if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
                return;
              }
              if (peerConnection.iceConnectionState === 'disconnected') {
                scheduleRetry('ICE stayed disconnected past grace period', generation);
              }
            }, ICE_DISCONNECTED_GRACE_MS);
          }
        };

        // Set up video handling
        peerConnection.ontrack = (event) => {
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
            return;
          }
          updateStatus('Received remote track: ' + event.track.kind);
          if (event.track.kind === 'video' && videoRef.current) {
            debugLog(`[${new Date().toISOString()}] Video track received:`, event.track);
            videoRef.current.srcObject = event.streams[0];
          }
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection || wsRef.current !== ws) {
            return;
          }
          if (event.candidate && ws.readyState === WebSocket.OPEN) {
            const message = {
              type: 'candidate',
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              sessionId: sessionId,
            };
            ws.send(JSON.stringify(message));
            updateStatus('Sent ICE candidate');
          } else {
            updateStatus('ICE candidate gathering completed');
          }
        };

        // Handle incoming messages
        ws.onmessage = async (event) => {
          if (!isCurrentAttempt() || wsRef.current !== ws) {
            return;
          }
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e) {
            debugWarn('Error parsing message:', e);
            return;
          }
          // Inspect-mode responses are routed to the fetcher first so it
          // can resolve in-flight requests regardless of which platform's
          // protocol is in use.
          if (axFetcherRef.current?.handleMessage(message)) {
            return;
          }
          updateStatus('Received: ' + message.type);
          switch (message.type) {
            case 'answer':
              if (!peerConnectionRef.current || peerConnectionRef.current !== peerConnection) {
                updateStatus('No peer connection, skipping answer');
                break;
              }
              await peerConnection.setRemoteDescription(
                new RTCSessionDescription({
                  type: 'answer',
                  sdp: message.sdp,
                }),
              );
              if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
                return;
              }
              updateStatus('Set remote description');
              break;
            case 'candidate':
              if (!peerConnectionRef.current || peerConnectionRef.current !== peerConnection) {
                updateStatus('No peer connection, skipping candidate');
                break;
              }
              await peerConnection.addIceCandidate(
                new RTCIceCandidate({
                  candidate: message.candidate,
                  sdpMid: message.sdpMid,
                  sdpMLineIndex: message.sdpMLineIndex,
                }),
              );
              if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
                return;
              }
              updateStatus('Added ICE candidate');
              break;
            case 'screenshot':
            case 'screenshotResult': {
              if (typeof message.id !== 'string') {
                debugWarn('Received invalid screenshot success message:', message);
                break;
              }
              const screenshotError = getScreenshotError(message);
              if (screenshotError) {
                const rejecter = pendingScreenshotRejectersRef.current.get(message.id);
                if (!rejecter) {
                  debugWarn(`Received screenshot error for unknown or handled id: ${message.id}`);
                  break;
                }
                debugWarn(`Received screenshot error for id ${message.id}: ${screenshotError}`);
                rejecter(new Error(screenshotError));
                pendingScreenshotResolversRef.current.delete(message.id);
                pendingScreenshotRejectersRef.current.delete(message.id);
                break;
              }
              const screenshotData = toScreenshotData(message);
              if (!screenshotData) {
                debugWarn('Received screenshot message without image data:', message);
                break;
              }
              const resolver = pendingScreenshotResolversRef.current.get(message.id);
              if (!resolver) {
                debugWarn(`Received screenshot data for unknown or handled id: ${message.id}`);
                break;
              }
              debugLog(`Received screenshot data for id ${message.id}`);
              resolver(screenshotData);
              pendingScreenshotResolversRef.current.delete(message.id);
              pendingScreenshotRejectersRef.current.delete(message.id);
              break;
            }
            case 'screenshotError':
              if (typeof message.id !== 'string' || typeof message.message !== 'string') {
                debugWarn('Received invalid screenshot error message:', message);
                break;
              }
              const rejecter = pendingScreenshotRejectersRef.current.get(message.id);
              if (!rejecter) {
                debugWarn(`Received screenshot error for unknown or handled id: ${message.id}`);
                break;
              }
              debugWarn(`Received screenshot error for id ${message.id}: ${message.message}`);
              rejecter(new Error(message.message));
              pendingScreenshotResolversRef.current.delete(message.id);
              pendingScreenshotRejectersRef.current.delete(message.id);
              break;
            case 'cameraRequest': {
              const active = message.active === true;
              // Bump up front so any earlier in-flight handler bails.
              const cameraGeneration = ++cameraRequestGenerationRef.current;
              const isCurrentCameraRequest = () =>
                isCurrentAttempt() &&
                wsRef.current === ws &&
                cameraGeneration === cameraRequestGenerationRef.current;
              // Log unconditionally — this is one of the few places we
              // hand control to the browser's permission UI, and a
              // silent failure here looks identical to "limulator
              // never asked" from the user's point of view.
              // eslint-disable-next-line no-console
              console.info('[RemoteControl] cameraRequest received, active=', active);
              if (!active) {
                // Sim no longer wants frames. Drop our local track and
                // shut the browser's camera green light off.
                const sender = outboundCameraSenderRef.current;
                if (sender) {
                  try {
                    await sender.replaceTrack(null);
                  } catch (err) {
                    debugWarn('replaceTrack(null) on camera detach failed:', err);
                  }
                }
                stopCameraStatsPoller();
                stopOutboundLocalStream();
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, false);
                break;
              }
              // Sim is asking for camera. Ask the browser; the user's
              // prompt response is reported back to the host via a
              // `cameraResult` message so it can swap to a
              // black-frame fallback on denial.
              safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true);
              if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
                // Likely an insecure context (http on a non-localhost
                // origin) — Chrome strips `mediaDevices` off
                // `navigator` in that case and the only signal is
                // this undefined check.
                // eslint-disable-next-line no-console
                console.warn(
                  '[RemoteControl] navigator.mediaDevices.getUserMedia unavailable. ' +
                    'getUserMedia requires a secure context (https or http://localhost). ' +
                    'Replying cameraResult granted=false so limulator falls back to black frames.',
                );
                ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, false);
                break;
              }
              let stream: MediaStream | null = null;
              try {
                // Capture at the webcam's *native* resolution by
                // default (no width/height constraints). When the
                // host app has picked an explicit cap via
                // `cameraResolutionCap`, we honour it here. Frame
                // rate is always capped to 30 to match the
                // simulator pool's pacing.
                stream = await navigator.mediaDevices.getUserMedia({
                  video: cameraCapToConstraints(cameraResolutionCapRef.current),
                  audio: false,
                });
              } catch (err) {
                // Surface unconditionally — the user is the only one
                // who can fix this (permission denied, no device,
                // dismissed prompt, etc.). `debugWarn` alone would
                // hide it in normal builds.
                // eslint-disable-next-line no-console
                console.warn('[RemoteControl] getUserMedia denied/failed:', err);
              }
              if (!isCurrentCameraRequest()) {
                // Superseded during the prompt; drop the stream we got.
                if (stream) stopMediaStream(stream);
                return;
              }
              if (!stream) {
                ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, false);
                break;
              }
              // Replace any previous local stream (e.g. an earlier
              // cameraRequest that resolved with a different device)
              // before we install the new tracks.
              stopOutboundLocalStream();
              outboundLocalStreamRef.current = stream;
              const sender = outboundCameraSenderRef.current;
              const videoTrack = stream.getVideoTracks()[0] ?? null;
              if (!sender || !videoTrack) {
                if (stream) stopMediaStream(stream);
                outboundLocalStreamRef.current = null;
                ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, false);
                break;
              }
              try {
                await sender.replaceTrack(videoTrack);
              } catch (err) {
                debugWarn('replaceTrack(videoTrack) failed:', err);
                stopMediaStream(stream);
                outboundLocalStreamRef.current = null;
                ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, false);
                break;
              }
              if (!isCurrentCameraRequest()) {
                // Superseded mid-attach; detach and skip the ACK/poller.
                try {
                  await sender.replaceTrack(null);
                } catch (err) {
                  debugWarn('replaceTrack(null) on stale camera attach failed:', err);
                }
                stopMediaStream(stream);
                if (outboundLocalStreamRef.current === stream) {
                  outboundLocalStreamRef.current = null;
                }
                return;
              }
              // Tell the encoder this is real motion content (a
              // physical camera), not text/slides. With `'motion'`
              // VideoToolbox / libvpx pick latency-friendly tuning
              // (no extra B-frames, shorter GoP smoothing). Set
              // before the first frame so the encoder init reads it.
              try {
                videoTrack.contentHint = 'motion';
              } catch {
                /* older browsers don't support contentHint; ignore */
              }
              // Bound the outbound bitrate generously and let
              // WebRTC's congestion control (BWE) find the floor.
              // 8 Mbps is comfortable for native 1080p30 webcam
              // content over LAN — the encoder will use far less when
              // the scene is static, and BWE will throttle if a
              // hop is constrained. Pair with
              // `maintain-framerate` so the quality scaler steps
              // down resolution before dropping frames, matching how
              // Meet/Zoom degrade.
              try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                  params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = 8_000_000;
                params.encodings[0].maxFramerate = 30;
                params.degradationPreference = 'maintain-framerate';
                await sender.setParameters(params);
              } catch (err) {
                debugWarn('setParameters on outbound camera failed:', err);
              }
              // Surface the actual captured geometry to the host so
              // it can size its IOSurface pool / picture-format
              // metadata to match. `getSettings()` returns what the
              // browser actually picked — which may differ from any
              // hints we sent in the constraints — including the
              // selected `deviceId` / `label` (useful when a user has
              // multiple cameras and we eventually expose a picker).
              let cameraMetadata: {
                width?: number;
                height?: number;
                frameRate?: number;
                deviceId?: string;
                label?: string;
                facingMode?: string;
              } = {};
              try {
                const settings = videoTrack.getSettings();
                cameraMetadata = {
                  width: settings.width,
                  height: settings.height,
                  frameRate: settings.frameRate,
                  deviceId: settings.deviceId,
                  label: videoTrack.label || undefined,
                  facingMode: settings.facingMode,
                };
                // eslint-disable-next-line no-console
                console.info(
                  `[RemoteControl] camera capture: ${cameraMetadata.width}x${cameraMetadata.height}` +
                    ` @ ${cameraMetadata.frameRate ?? '?'}fps` +
                    (cameraMetadata.label ? ` — ${cameraMetadata.label}` : ''),
                );
              } catch (err) {
                debugWarn('getSettings() on outbound camera track failed:', err);
              }
              // If the browser revokes the track later (extension,
              // user clicks Stop in the camera tab UI, etc.), notify
              // the host so it can switch to black frames.
              videoTrack.onended = () => {
                if (outboundLocalStreamRef.current !== stream) return;
                stopCameraStatsPoller();
                stopOutboundLocalStream();
                if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
                }
                safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, false);
              };
              if (!isCurrentCameraRequest()) {
                // Superseded during setParameters; detach and bail.
                videoTrack.onended = null;
                try {
                  await sender.replaceTrack(null);
                } catch (err) {
                  debugWarn('replaceTrack(null) on stale camera finalize failed:', err);
                }
                stopMediaStream(stream);
                if (outboundLocalStreamRef.current === stream) {
                  outboundLocalStreamRef.current = null;
                }
                return;
              }
              ws.send(
                JSON.stringify({
                  type: 'cameraResult',
                  granted: true,
                  // Forward what the browser actually captured so the
                  // host can size its IOSurface pool, log the device,
                  // and (eventually) surface a status pill / picker.
                  camera: cameraMetadata,
                }),
              );
              safeInvoke('onCameraDemandChange', onCameraDemandChangeRef.current, true, true, cameraMetadata);
              // Kick off the per-second outbound stats sampler. We do
              // this *after* `setParameters` so the first sample
              // already sees the encoder under its final bitrate /
              // degradation policy, and *after* the host-side
              // attachInboundTrack will have wired up (the
              // cameraResult ACK is what triggers it on the host),
              // so framesEncoded starts climbing immediately.
              startCameraStatsPoller();
              break;
            }
            case 'terminateAppResult':
              if (typeof message.id !== 'string') {
                debugWarn('Received invalid terminateApp result message:', message);
                break;
              }
              if (typeof message.error === 'string') {
                const terminateRejecter = pendingTerminateAppRejectersRef.current.get(message.id);
                if (!terminateRejecter) {
                  debugWarn(`Received terminateApp error for unknown or handled id: ${message.id}`);
                  break;
                }
                debugWarn(`Received terminateApp error for id ${message.id}: ${message.error}`);
                terminateRejecter(new Error(message.error));
                pendingTerminateAppResolversRef.current.delete(message.id);
                pendingTerminateAppRejectersRef.current.delete(message.id);
                break;
              }
              const terminateResolver = pendingTerminateAppResolversRef.current.get(message.id);
              if (!terminateResolver) {
                debugWarn(`Received terminateApp result for unknown or handled id: ${message.id}`);
                break;
              }
              debugLog(`Received terminateApp success for id ${message.id}`);
              terminateResolver();
              pendingTerminateAppResolversRef.current.delete(message.id);
              pendingTerminateAppRejectersRef.current.delete(message.id);
              break;
            default:
              debugWarn(`Received unhandled message type: ${message.type}`, message);
              break;
          }
        };

        // Create and send offer
        if (peerConnectionRef.current === peerConnection) {
          const offer = await peerConnection.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false,
          });
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
            return;
          }
          await peerConnection.setLocalDescription(offer);
          if (!isCurrentAttempt() || peerConnectionRef.current !== peerConnection) {
            return;
          }

          if (isCurrentAttempt() && wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'offer',
                sdp: offer.sdp,
                sessionId: sessionId,
              }),
            );
          }
          updateStatus('Sent offer');
        }
      } catch (e) {
        if (!isCurrentAttempt()) {
          return;
        }
        const reason = e instanceof Error ? e.message : String(e);
        updateStatus('Error: ' + reason);
        scheduleRetry(reason, generation);
      }
    };

    const start = () => {
      void startAttempt(0);
    };

    const stop = () => {
      connectionGenerationRef.current += 1;
      connectionAttemptRef.current = 0;
      controlChannelOpenedRef.current = false;
      clearScheduledRetry();
      clearIceDisconnectedGrace();
      teardownConnection();
      updateStatus('Stopped');
    };

    const handleManualRetry = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      start();
    };

    // Re-apply the resolution cap on the currently-sending track
    // whenever the host app changes its preference. Skips when no
    // camera is active — the next `getUserMedia` will pick up the
    // new value via `cameraCapToConstraints` automatically.
    useEffect(() => {
      const stream = outboundLocalStreamRef.current;
      if (!stream) return;
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      const constraints = cameraCapToConstraints(cameraResolutionCap);
      track.applyConstraints(constraints).catch((err) => {
        debugWarn('applyConstraints for new camera cap failed:', err);
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraResolutionCap]);

    // Push the aspect preference to the host whenever it changes.
    // The host rebuilds its IOSurface pool and bumps `pool_generation`
    // on its end; the dylib re-handshakes on next sem_wait. No
    // peer-connection renegotiation is needed — the aspect change is
    // purely about the pixel buffer dimensions iOS apps observe, not
    // about WebRTC track layout. The `cameraAspectRef` is mirrored
    // higher up so the WS `onopen` reconnect path can replay the
    // latest value on fresh connections.
    useEffect(() => {
      if (!cameraAspect) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'cameraAspect', aspect: cameraAspect }));
      } catch (err) {
        debugWarn('cameraAspect send failed:', err);
      }
    }, [cameraAspect]);

    useEffect(() => {
      // Reset video loaded state when connection params change
      setVideoLoaded(false);

      // Start connection when component mounts
      start();

      // Only start keepAlive if page is visible
      if (!document.hidden) {
        startKeepAlive();
      }

      // Add visibility change listener
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Clean up
      return () => {
        stopKeepAlive();
        stop();
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
      // Camera attach/detach happens entirely inside the WS message
      // loop now (sendonly transceiver + `replaceTrack`), so the
      // connection effect doesn't need to bounce when the camera
      // turns on/off — no SDP-affecting change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, token, propSessionId]);

    // Recompute the inspect-overlay geometry (container-local pixel rect of
    // the actually-rendered video content) from the current mapping context.
    // The InfoCard places itself in viewport coordinates from pointer events
    // directly, so no viewport-space origin is needed in the geometry.
    const recomputeOverlayGeometry = () => {
      const ctx = computeVideoMappingContext();
      if (!ctx) {
        setOverlayGeometry(null);
        return;
      }
      const next: InspectOverlayGeometry = {
        left: ctx.videoRect.left - ctx.containerRect.left + ctx.offsetX,
        top: ctx.videoRect.top - ctx.containerRect.top + ctx.offsetY,
        width: ctx.actualWidth,
        height: ctx.actualHeight,
      };
      setOverlayGeometry((prev) =>
        (
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
        ) ?
          prev
        : next,
      );
    };

    // Calculate video position and border-radius based on frame dimensions
    useEffect(() => {
      const video = videoRef.current;
      const frame = frameRef.current;
      const container = containerRef.current;

      if (!video) return;

      const updateVideoPosition = () => {
        // If no frame, just refresh overlay geometry; no inset/letterbox math
        // is needed since the video element is its own size.
        if (!showFrame || !frame) {
          setVideoStyle({});
          recomputeOverlayGeometry();
          return;
        }

        const frameWidth = frame.clientWidth;
        const frameHeight = frame.clientHeight;

        if (frameWidth === 0 || frameHeight === 0) return;

        // Determine landscape based on video's intrinsic dimensions
        const landscape = video.videoWidth > video.videoHeight;
        setIsLandscape(landscape);
        setUseAndroidTabletFrame(
          platform === 'android' && isAndroidTabletVideo(video.videoWidth, video.videoHeight),
        );

        const pos = landscape ? config.videoPosition.landscape : config.videoPosition.portrait;
        let newStyle: React.CSSProperties = {};
        if (pos.heightMultiplier) {
          newStyle.height = `${frameHeight * pos.heightMultiplier}px`;
          // Let the other dimension follow the video stream's intrinsic aspect ratio.
          newStyle.width = 'auto';
        } else if (pos.widthMultiplier) {
          newStyle.width = `${frameWidth * pos.widthMultiplier}px`;
          // Let the other dimension follow the video stream's intrinsic aspect ratio.
          newStyle.height = 'auto';
        }
        newStyle.borderRadius = `${
          landscape ?
            frameHeight * config.videoBorderRadiusMultiplier
          : frameWidth * config.videoBorderRadiusMultiplier
        }px`;
        setVideoStyle(newStyle);
        recomputeOverlayGeometry();
      };

      const resizeObserver = new ResizeObserver(() => {
        updateVideoPosition();
      });

      if (frame) resizeObserver.observe(frame);
      resizeObserver.observe(video);
      if (container) resizeObserver.observe(container);

      // Also update when the frame image loads
      if (frame) frame.addEventListener('load', updateVideoPosition);

      // Update when video metadata loads (to get correct intrinsic dimensions)
      video.addEventListener('loadedmetadata', updateVideoPosition);

      // IMPORTANT: When the WebRTC stream changes orientation, the intrinsic video size
      // (videoWidth/videoHeight) can change without re-firing 'loadedmetadata'.
      // The <video> element emits 'resize' in that case.
      video.addEventListener('resize', updateVideoPosition);
      // Orientation flips also mean every element's AX frame just changed
      // (portrait↔landscape rotates the layout). Bump so the overlay
      // refreshes immediately rather than waiting out the current poll
      // cycle in a layout that no longer matches the boxes.
      const bumpOnResize = () => axFetcherRef.current?.bumpActivity();
      video.addEventListener('resize', bumpOnResize);

      // Initial calculation
      updateVideoPosition();

      return () => {
        resizeObserver.disconnect();
        video.removeEventListener('loadedmetadata', updateVideoPosition);
        video.removeEventListener('resize', updateVideoPosition);
        video.removeEventListener('resize', bumpOnResize);
        if (frame) frame.removeEventListener('load', updateVideoPosition);
      };
    }, [config, showFrame]);

    // Start/stop the AX poller and reset inspect state when inspect mode
    // toggles. Connection state is independent: the fetcher gets created on
    // dataChannel.onopen and destroyed on teardown.
    useEffect(() => {
      const fetcher = axFetcherRef.current;
      if (inspectActive) {
        fetcher?.start();
      } else {
        fetcher?.stop();
        setAxSnapshot(null);
        setAxHighlightedId(null);
        setAxSelectedId(null);
        setAxCursorPosition(null);
        setAxFrozenCursorPosition(null);
        cursorPositionRef.current = null;
        if (cursorRafIdRef.current !== undefined) {
          window.cancelAnimationFrame(cursorRafIdRef.current);
          cursorRafIdRef.current = undefined;
        }
        safeInvoke('onAxSnapshotChange', onAxSnapshotChangeRef.current, null);
      }
    }, [inspectActive]);

    // Cancel any pending cursor-rAF on unmount so we don't setState on a
    // dead component.
    useEffect(() => {
      return () => {
        if (cursorRafIdRef.current !== undefined) {
          window.cancelAnimationFrame(cursorRafIdRef.current);
          cursorRafIdRef.current = undefined;
        }
      };
    }, []);

    // ESC clears overlay selection (Chrome DevTools behavior).
    useEffect(() => {
      if (!inspectActive) return;
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && (axSelectedId || axHighlightedId)) {
          setAxSelectedId(null);
          setAxHighlightedId(null);
          setAxFrozenCursorPosition(null);
          safeInvoke('onInspectSelectionChange', onInspectSelectionChangeRef.current, null);
        }
      };
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }, [inspectActive, axSelectedId, axHighlightedId]);

    const handleVideoClick = () => {
      if (videoRef.current) {
        videoRef.current.focus();
      }
    };

    // Expose sendOpenUrlCommand via ref
    useImperativeHandle(ref, () => ({
      openUrl: (newUrl: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          debugWarn('WebSocket not open, cannot send open_url command via ref.');
          return;
        }
        try {
          const decodedUrl = decodeURIComponent(newUrl);
          updateStatus('Opening URL');
          wsRef.current.send(
            JSON.stringify({
              type: 'openUrl',
              url: decodedUrl,
              sessionId: sessionId,
            }),
          );
        } catch (error) {
          debugWarn('Error decoding or sending URL via ref:', { error, url: newUrl });
          wsRef.current.send(
            JSON.stringify({
              type: 'openUrl',
              url: newUrl,
              sessionId: sessionId,
            }),
          );
        }
        axFetcherRef.current?.bumpActivity();
      },

      sendKeyEvent: (event: ImperativeKeyboardEvent) => {
        if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
          debugWarn('Data channel not ready for imperative key command:', dataChannelRef.current?.readyState);
          return;
        }

        const keycode = codeMap[event.code];
        if (!keycode) {
          debugWarn(`Unknown event.code for imperative command: ${event.code}`);
          return;
        }

        let metaState = ANDROID_KEYS.META_NONE;
        if (event.shiftKey) metaState |= ANDROID_KEYS.META_SHIFT_ON;
        if (event.altKey) metaState |= ANDROID_KEYS.META_ALT_ON;
        if (event.ctrlKey) metaState |= ANDROID_KEYS.META_CTRL_ON;
        if (event.metaKey) metaState |= ANDROID_KEYS.META_META_ON;

        const action = event.type === 'keydown' ? ANDROID_KEYS.ACTION_DOWN : ANDROID_KEYS.ACTION_UP;

        debugLog(
          `Sending Imperative Key Command: code=${event.code}, keycode=${keycode}, action=${action}, meta=${metaState}`,
        );

        const message = createInjectKeycodeMessage(
          action,
          keycode,
          0, // repeat count, typically 0 for single presses
          metaState,
        );
        if (message) {
          sendBinaryControlMessage(message);
        }
      },
      screenshot: (): Promise<ScreenshotData> => {
        return new Promise<ScreenshotData>((resolve, reject) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            debugWarn('WebSocket not open, cannot send screenshot command.');
            return reject(new Error('WebSocket is not connected or connection is not open.'));
          }

          const id = `ui-ss-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const request = {
            type: 'screenshot', // Matches the type expected by instance API
            id: id,
          };

          pendingScreenshotResolversRef.current.set(id, resolve);
          pendingScreenshotRejectersRef.current.set(id, reject);

          debugLog('Sending screenshot request:', request);
          try {
            wsRef.current.send(JSON.stringify(request));
          } catch (err) {
            debugWarn('Failed to send screenshot request immediately:', err);
            pendingScreenshotResolversRef.current.delete(id);
            pendingScreenshotRejectersRef.current.delete(id);
            reject(err);
            return; // Important to return here if send failed synchronously
          }

          setTimeout(() => {
            if (pendingScreenshotResolversRef.current.has(id)) {
              debugWarn(`Screenshot request timed out for id ${id}`);
              pendingScreenshotRejectersRef.current.get(id)?.(new Error('Screenshot request timed out'));
              pendingScreenshotResolversRef.current.delete(id);
              pendingScreenshotRejectersRef.current.delete(id);
            }
          }, 30000); // 30-second timeout
        });
      },
      terminateApp: (bundleId: string): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            debugWarn('WebSocket not open, cannot send terminateApp command.');
            return reject(new Error('WebSocket is not connected or connection is not open.'));
          }
          const id = `ui-term-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const request = {
            type: 'terminateApp',
            id,
            bundleId,
          };

          pendingTerminateAppResolversRef.current.set(id, resolve);
          pendingTerminateAppRejectersRef.current.set(id, reject);

          debugLog('Sending terminateApp request:', request);
          try {
            wsRef.current.send(JSON.stringify(request));
          } catch (err) {
            debugWarn('Failed to send terminateApp request immediately:', err);
            pendingTerminateAppResolversRef.current.delete(id);
            pendingTerminateAppRejectersRef.current.delete(id);
            reject(err);
            return;
          }
          // Terminating the foreground app drops the user back to the home
          // screen — bump so the overlay reflects the post-terminate state
          // through the SpringBoard transition.
          axFetcherRef.current?.bumpActivity();

          setTimeout(() => {
            if (pendingTerminateAppResolversRef.current.has(id)) {
              debugWarn(`terminateApp request timed out for id ${id}`);
              pendingTerminateAppRejectersRef.current.get(id)?.(new Error('terminateApp request timed out'));
              pendingTerminateAppResolversRef.current.delete(id);
              pendingTerminateAppRejectersRef.current.delete(id);
            }
          }, 30000);
        });
      },
      reconnect: () => start(),

      refreshAxTree: async (): Promise<AxSnapshot> => {
        const fetcher = axFetcherRef.current;
        if (!fetcher) {
          throw new Error('Inspect mode is not active');
        }
        // The fetcher's refresh() runs the result through the same
        // change-detect path as the poll loop (via deliver()), which calls
        // back into onSnapshot — already wired to setAxSnapshot +
        // onAxSnapshotChange (with safe-invoke). We just return the fetched
        // payload for callers that want it.
        return fetcher.refresh();
      },

      getAxSnapshot: () => axSnapshotRef.current,

      setInspectHighlight: (element: AxElement | null) => {
        setAxHighlightedId(element?.id ?? null);
      },

      setInspectSelection: (element: AxElement | null) => {
        setAxSelectedId(element?.id ?? null);
        // Programmatic selection has no click position — anchor the card at
        // the last known cursor position (if any), otherwise clear.
        // Customer-facing UIs that drive selection from their own panels can
        // call setInspectHighlight separately to move the cursor visual.
        if (element) {
          setAxFrozenCursorPosition(cursorPositionRef.current);
        } else {
          setAxFrozenCursorPosition(null);
        }
        const snapshot = axSnapshotRef.current;
        if (element && snapshot) {
          safeInvoke('onInspectSelectionChange', onInspectSelectionChangeRef.current, { element, snapshot });
        } else {
          safeInvoke('onInspectSelectionChange', onInspectSelectionChangeRef.current, null);
        }
      },

      getAxStatus: () => axFetcherRef.current?.getStatus() ?? 'idle',
    }));

    // Show indicators when Alt is held and we have a valid hover point (null when outside)
    const showAltIndicators = isAltHeld && hoverPoint !== null;
    const frameImageSrc =
      platform === 'android' && useAndroidTabletFrame ?
        isLandscape ? pixelTabletFrameImageLandscape
        : pixelTabletFrameImage
      : isLandscape ? config.frame.imageLandscape
      : config.frame.image;

    return (
      <div
        ref={containerRef}
        className={clsx('rc-container', className)}
        style={{ touchAction: 'none' }} // Keep touchAction none for the container
        // Attach unified handler to all interaction events on the container
        // This helps capture mouseleave correctly even if the video element itself isn't hovered
        onMouseDown={handleInteraction}
        onMouseMove={handleInteraction}
        onMouseUp={handleInteraction}
        onMouseLeave={handleInteraction} // Handle mouse leaving the container
        onTouchStart={handleInteraction}
        onTouchMove={handleInteraction}
        onTouchEnd={handleInteraction}
        onTouchCancel={handleInteraction}
      >
        {showAltIndicators && hoverPoint && (
          <>
            <div
              className="rc-touch-indicator"
              style={{
                left: `${hoverPoint.containerX}px`,
                top: `${hoverPoint.containerY}px`,
              }}
            />
            <div
              className="rc-touch-indicator"
              style={{
                left: `${hoverPoint.mirrorContainerX}px`,
                top: `${hoverPoint.mirrorContainerY}px`,
              }}
            />
          </>
        )}
        {showFrame && (
          <img
            ref={frameRef}
            src={frameImageSrc}
            alt=""
            className={platform === 'ios' ? clsx('rc-phone-frame', 'rc-phone-frame-ios') : 'rc-phone-frame'}
            draggable={false}
          />
        )}
        <video
          ref={videoRef}
          className={clsx('rc-video', !showFrame && 'rc-video-frameless', !videoLoaded && 'rc-video-loading')}
          style={{
            ...videoStyle,
            ...(config.loadingLogo ?
              {
                backgroundImage: `url("${config.loadingLogo}")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundSize: config.loadingLogoSize,
              }
            : {}),
          }}
          autoPlay
          playsInline
          muted
          tabIndex={0}
          onKeyDown={handleKeyboard}
          onKeyUp={handleKeyboard}
          onClick={handleVideoClick}
          onLoadedData={markFirstFrameShown}
          onFocus={() => {
            if (videoRef.current) {
              videoRef.current.style.outline = 'none';
            }
          }}
          onBlur={() => {
            if (videoRef.current) {
              videoRef.current.style.outline = 'none';
            }
          }}
        />
        {inspectActive && (
          <InspectOverlay
            snapshot={axSnapshot}
            geometry={overlayGeometry}
            highlightedId={axHighlightedId}
            selectedId={axSelectedId}
            mode={inspectModeResolved}
            cursorPosition={axCursorPosition}
            frozenCursorPosition={axFrozenCursorPosition}
            onSelectChange={(element, clickPosition) => {
              setAxSelectedId(element?.id ?? null);
              if (element && clickPosition) {
                setAxFrozenCursorPosition(clickPosition);
              } else if (!element) {
                setAxFrozenCursorPosition(null);
              }
              const snapshot = axSnapshotRef.current;
              if (element && snapshot) {
                safeInvoke('onInspectSelectionChange', onInspectSelectionChangeRef.current, {
                  element,
                  snapshot,
                });
              } else {
                safeInvoke('onInspectSelectionChange', onInspectSelectionChangeRef.current, null);
              }
            }}
            onTapElement={(element, tapAt) => {
              // Use the viewport-space position the user originally aimed at
              // (the frozen click position). For containers whose children
              // are absent from the accessibility tree — e.g. iOS UITabBar's
              // home/diagnostics/settings buttons — this taps the specific
              // button the user pointed at instead of the container's
              // averaged center.
              if (tapAt) {
                sendTapAtClient(tapAt.x, tapAt.y);
                return;
              }
              // Fallback (defensive): center of element. Should be
              // unreachable from the InfoCard since it always passes anchor.
              const snapshot = axSnapshotRef.current;
              if (!snapshot) return;
              sendTapAtElementCenter(element, snapshot);
            }}
          />
        )}
        {retryExhausted && (
          <button type="button" className="rc-retry-button" onClick={handleManualRetry}>
            Retry
          </button>
        )}
      </div>
    );
  },
);

const getScreenshotError = (message: any): string | null => {
  if (typeof message.message === 'string') {
    return message.message;
  }

  if (typeof message.error === 'string') {
    return message.error;
  }

  return null;
};

const toScreenshotData = (message: any): ScreenshotData | null => {
  if (typeof message.dataUri === 'string') {
    return { dataUri: message.dataUri };
  }

  if (typeof message.base64 === 'string') {
    if (message.base64.startsWith('data:')) {
      return { dataUri: message.base64 };
    }

    const mimeType = message.base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
    return { dataUri: `data:${mimeType};base64,${message.base64}` };
  }

  return null;
};
