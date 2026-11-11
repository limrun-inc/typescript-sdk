import { createDeviceStream, type DeviceStream } from '../core/device-stream';
import { detectPlatform, debugLog, debugWarn, safeInvoke, type DevicePlatform } from '../core/stream-utils';
import type {
  ScreenshotData,
  ImperativeKeyboardEvent,
  RemoteControlConnectionState,
  MicrophoneState,
  CameraStreamStats,
} from '../core/stream-types';
export type { RemoteControlConnectionState, MicrophoneState, CameraStreamStats } from '../core/stream-types';
export { withAuthenticationToken } from '../core/stream-utils';
import React, {
  useEffect,
  useRef,
  useMemo,
  useState,
  forwardRef,
  useImperativeHandle,
  lazy,
  Suspense,
} from 'react';
import './remote-control.css';

import { type DuoState, type DuoOrientation } from '../core/duo';
const DuoView = lazy(() => import('./duo-view'));

import { ANDROID_KEYS, AMOTION_EVENT, codeMap } from '../core/constants';
import type { PlaybackStats } from '../core/playback-stats';

import {
  createTouchControlMessage,
  createInjectKeycodeMessage,
  createSetClipboardMessage,
  createTwoFingerTouchControlMessage,
} from '../core/webrtc-messages';
import { type AxStatus, type AndroidElementTreeOptions } from '../core/ax-fetcher';
import { AxElement, AxSnapshot, axElementAtPoint, axSnapshotsEqual } from '../core/ax-tree';
import type { CameraCaptureInfo } from '../core/camera';
import { InspectOverlay, InspectOverlayGeometry, InspectMode } from './inspect-overlay';
import { tokenRequiresWatchOnly } from './remote-control-permissions';

export type { CameraCaptureInfo, CameraFacingMode, CameraRequest, CameraResult } from '../core/camera';

declare global {
  interface Window {
    debugRemoteControl?: boolean;
  }
}

export interface RemoteControlProps {
  /** Disable input and media forwarding. Also enabled automatically for a watch-only token; false cannot override its restriction. */
  watchOnly?: boolean;
  /** Receives latency trace messages from supported iOS and Android instances. Adding or removing the callback reconnects the stream. */
  onTrace?: (message: Record<string, unknown>) => void;

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
  // If empty, the component generates a random one on mount and when the token changes.
  // If supplied, change it whenever the token changes.
  sessionId?: string;

  // openUrl is the URL to open in the instance when the
  // component is ready.
  //
  // If not provided, the component will not open any URL.
  openUrl?: string;

  // showFrame controls whether to display the device frame
  // around the video. Defaults to true.
  showFrame?: boolean;

  /** Enables the official iPhone Duo's native displays and interactive folding frame. */
  deviceModel?: 'iphone-duo';

  /** Optional prepared Duo GLB, supplied and licensed by the host application. */
  duoModelUrl?: string;

  // When true, drops after a working session auto-reconnect instead of
  // surfacing the manual "Retry" button. Defaults to true.
  autoReconnect?: boolean;

  /**
   * Preferred playback jitter buffer duration in milliseconds (0–4000), for
   * incoming audio and video. Lower values can reduce latency but increase
   * dropped frames or freezes. This is a preference, not a latency limit.
   * Updates apply without reconnecting. Omit or pass null to use the browser
   * default. Unsupported browsers ignore this prop. Invalid values are ignored
   * with a console warning, leaving the previous target unchanged.
   */
  jitterBufferTargetMs?: number | null;

  /**
   * Incoming playback stats, sampled every two seconds while subscribed,
   * connected, and visible. Works with iOS and Android, including Duo displays.
   * Missing measurements stay undefined; the first sample establishes a baseline.
   * Emits null when collection pauses, disconnects, or fails after a sample.
   * Buffer delay measures receiving-side buffering, not tap-to-screen latency.
   */
  onPlaybackStats?: (stats: PlaybackStats | null) => void;

  /**
   * Fires once when the component concludes the instance is permanently
   * gone rather than suffering a recoverable connection blip.
   *
   * After a drop, the component probes the instance endpoint over HTTP;
   * a 404 means the instance no longer exists (terminated/deleted). When
   * that happens the component stops reconnecting and renders a built-in
   * "terminated" message in place of the "Retry" button, and invokes this
   * callback so the host can react (navigate away, surface its own UI,
   * etc.). It is not called for ordinary network drops.
   */
  onTerminated?: () => void;
  /**
   * Device frame and boot-logo images. The default export bundles Limrun's
   * frames; `@limrun/ui/lite` omits them so a frameless embed stays small.
   */
  assets?: RemoteControlAssets;
  /**
   * Coarse connection lifecycle, for status UI outside the component.
   */
  onConnectionStateChange?: (state: RemoteControlConnectionState) => void;

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

  androidElementTreeOptions?: AndroidElementTreeOptions;

  /**
   * Fires whenever the iOS simulator's camera demand state changes —
   * i.e. an app inside the sim called
   * `[AVCaptureSession startRunning]` or `[stopRunning]`. The
   * component handles the `navigator.mediaDevices.getUserMedia` prompt
   * and SDP plumbing internally; this callback is purely so the host
   * UI can render a status indicator ("simulator is using your
   * camera", etc.).
   *
   * `active` reflects whether the sim is currently asking for frames.
   * `granted` is set on capture acknowledgements: `true` after a new
   * track, reused track, or constraint update; `false` when capture
   * fails. The host switches to black frames after a failure.
   *
   * `camera` (optional, only meaningful when `granted === true`)
   * carries what `MediaStreamTrack.getSettings()` reported for the
   * active capture: resolution, framerate, device label, facing
   * mode. Use it to render a richer status indicator (e.g.
   * "Camera · 1920×1080 · 30 fps · FaceTime HD").
   *
   * iOS instances always fire this callback. Android instances fire it
   * when the server supports camera injection (Android 15+); older
   * Android instances have no camera-injector path and stay silent.
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
   * When true, capture the user's microphone via
   * `getUserMedia({ audio: true })` and stream it live into the
   * device's mock microphone. This is a manual override: apps
   * that actively consume microphone input also trigger capture
   * automatically, like camera demand. The component handles the
   * browser permission prompt, WebRTC track attachment, and
   * `microphoneStart`/`microphoneStop` signaling. Progress and failures
   * are reported via `onMicrophoneStateChange`. Ignored on Android
   * servers without camera/mic injection support (Android 14 and older).
   */
  microphoneEnabled?: boolean;

  /**
   * Fires whenever the live-microphone pipeline changes state:
   * after a manual or guest-demanded attempt resolves, when the host
   * acknowledges or rejects the stream, when the browser revokes the
   * track mid-stream, and when capture stops.
   */
  onMicrophoneStateChange?: (state: MicrophoneState) => void;
}

export interface RemoteControlHandle {
  openUrl: (url: string) => void;
  sendKeyEvent: (event: ImperativeKeyboardEvent) => void;
  screenshot: (display?: 'outer' | 'inner') => Promise<ScreenshotData>;
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

const motionActionToString = (action: number): string => {
  // AMOTION_EVENT is a constants object; find the matching ACTION_* key if present
  const match = Object.entries(AMOTION_EVENT).find(
    ([key, value]) => key.startsWith('ACTION_') && value === action,
  );
  return match?.[0] ?? String(action);
};

export type RemoteControlPlatformAssets = {
  frame?: string;
  frameLandscape?: string;
  tabletFrame?: string;
  tabletFrameLandscape?: string;
  loadingLogo?: string;
};

export type RemoteControlAssets = Partial<Record<DevicePlatform, RemoteControlPlatformAssets>>;

type DeviceConfig = {
  videoBorderRadiusMultiplier: number;
  loadingLogoSize: string;
  videoPosition: {
    portrait: { heightMultiplier?: number; widthMultiplier?: number };
    landscape: { heightMultiplier?: number; widthMultiplier?: number };
  };
};

const ANDROID_TABLET_VIDEO_WIDTH = 1920;
const ANDROID_TABLET_VIDEO_HEIGHT = 1200;
// Upper bound for the one-shot HTTP probe that disambiguates a terminated
// instance (endpoint 404s) from a transient connection drop.

const isAndroidTabletVideo = (width: number, height: number): boolean =>
  (width === ANDROID_TABLET_VIDEO_WIDTH && height === ANDROID_TABLET_VIDEO_HEIGHT) ||
  (width === ANDROID_TABLET_VIDEO_HEIGHT && height === ANDROID_TABLET_VIDEO_WIDTH);

// Device-specific configuration for frame sizing and video positioning
// Video position percentages are relative to the frame image dimensions
const deviceConfig: Record<DevicePlatform, DeviceConfig> = {
  ios: {
    videoBorderRadiusMultiplier: 0.15,
    loadingLogoSize: '20%',
    // Video position as percentage of frame dimensions
    videoPosition: {
      portrait: { heightMultiplier: 0.9678 },
      landscape: { widthMultiplier: 0.9678 },
    },
  },
  android: {
    videoBorderRadiusMultiplier: 0.13,
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

function sameStyle(a: React.CSSProperties, b: React.CSSProperties): boolean {
  const keys = Object.keys(a) as (keyof React.CSSProperties)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export const RemoteControl = forwardRef<RemoteControlHandle, RemoteControlProps>(
  (
    {
      className,
      url,
      token,
      sessionId: propSessionId,
      openUrl,
      watchOnly: requestedWatchOnly = false,
      showFrame = true,
      deviceModel,
      duoModelUrl,
      autoReconnect,
      jitterBufferTargetMs,
      onPlaybackStats,
      onTerminated,
      assets,
      onConnectionStateChange,
      inspectMode,
      onAxSnapshotChange,
      onInspectSelectionChange,
      onAxStatusChange,
      axPollIntervalMs,
      axMaxBackoffMs,
      androidElementTreeOptions,
      onCameraDemandChange,
      onCameraStats,
      onTrace,
      microphoneEnabled = false,
      onMicrophoneStateChange,
    }: RemoteControlProps,
    ref,
  ) => {
    const tokenWatchOnly = useMemo(() => tokenRequiresWatchOnly(url, token), [url, token]);
    const watchOnly = requestedWatchOnly || tokenWatchOnly;
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const frameRef = useRef<HTMLImageElement>(null);
    const [detectedDuo, setDetectedDuo] = useState(false);
    const isDuo = deviceModel === 'iphone-duo' || detectedDuo;
    const innerVideoRef = useRef<HTMLVideoElement>(null);
    const [duoState, setDuoState] = useState<DuoState | null>(null);
    const [duoError, setDuoError] = useState<string>();
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [retryExhausted, setRetryExhausted] = useState(false);
    // Set once we've concluded the instance is permanently gone (its
    // endpoint 404s after a drop), as opposed to a recoverable blip. When
    // set, reconnection stops and a terminated message replaces "Retry".
    const [terminated, setTerminated] = useState(false);
    const [isLandscape, setIsLandscape] = useState(false);
    const [useAndroidTabletFrame, setUseAndroidTabletFrame] = useState(false);
    const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({});
    const lastVideoSize = useRef<{ width: number; height: number } | null>(null);
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
    // Wheel-scroll drag state; lives for a single synthesized gesture.
    const wheelStateRef = useRef<{ pos: PointerGeometry; endTimer: number } | null>(null);
    // Latest wheel handlers, so the once-attached native listener and the
    // pointer machinery always call the current render's closures.
    const wheelCallbacksRef = useRef<{ handle: (event: WheelEvent) => void; end: () => void }>({
      handle: () => {},
      end: () => {},
    });

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
    const axSnapshotRef = useRef<AxSnapshot | null>(null);
    axSnapshotRef.current = axSnapshot;
    const onInspectSelectionChangeRef = useRef(onInspectSelectionChange);
    onInspectSelectionChangeRef.current = onInspectSelectionChange;
    const inspectActive = inspectMode === true || inspectMode === 'hover-only';
    const inspectActiveRef = useRef(inspectActive);
    inspectActiveRef.current = inspectActive;
    const inspectModeResolved: InspectMode = inspectMode === 'hover-only' ? 'hover-only' : 'select';

    const platform = useMemo(() => detectPlatform(url), [url]);
    const sessionId = useMemo(
      () =>
        propSessionId ||
        Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join(''),
      [propSessionId, token],
    );
    const config = deviceConfig[platform];
    const platformAssets = assets?.[platform];
    const frameImageSrc =
      platform === 'android' && useAndroidTabletFrame ?
        isLandscape ? platformAssets?.tabletFrameLandscape
        : platformAssets?.tabletFrame
      : isLandscape ? platformAssets?.frameLandscape
      : platformAssets?.frame;
    const loadingLogo = platformAssets?.loadingLogo;
    // Without a frame image (the lite entry) the video lays out frameless
    // whatever showFrame says.
    const frameVisible = !isDuo && showFrame && !!frameImageSrc;

    const clientRef = useRef<DeviceStream | null>(null);
    const sendBinaryControlMessage = (data: ArrayBuffer) => clientRef.current?.sendControl(data);
    const sendDuoControl = (type: string, parameters: object) =>
      clientRef.current?.sendDuoControl(type, parameters) ??
      Promise.reject(new Error('Simulator disconnected'));
    // Pointer ID used by inspect-driven taps. Distinct from human pointers
    // (-1 mouse, -2 alt-mirror), the synthesized wheel finger (-3), and our
    // touch identifiers so they never interfere with an in-progress drag.
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
    // Synthesized finger for wheel-scroll drags.
    const WHEEL_POINTER_ID = -3;

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
          // A real pointer going down takes over from any synthesized
          // wheel-scroll finger, so the tap isn't sent as a second finger.
          if (pointerId !== WHEEL_POINTER_ID) {
            wheelCallbacksRef.current.end();
          }
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
      if (platform === 'ios' && clientRef.current?.getState().controlReady) {
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

      if (eventType === 'down') {
        // A real two-finger gesture takes over from any synthesized
        // wheel-scroll finger.
        wheelCallbacksRef.current.end();
      }

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
      if (isDuo) return;
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
      const isInspecting = inspectMode === true || inspectMode === 'hover-only';
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
      if (inspectMode === true) {
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

      if (!clientRef.current?.getState().controlReady || !videoRef.current || !ctx) {
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

    // Mouse wheel / trackpad scrolling over the stream scrolls inside the
    // simulator. iOS has no scroll wheel, so we fake a finger: press down
    // where the cursor is, drag it as wheel events come in, lift when they
    // stop. If the fake finger reaches the screen edge before the user stops
    // scrolling, lift and press again to keep going.
    const WHEEL_END_QUIET_MS = 150;
    const endWheelGesture = () => {
      const state = wheelStateRef.current;
      if (!state) return;
      window.clearTimeout(state.endTimer);
      applyPointerEvent(WHEEL_POINTER_ID, 'up', state.pos);
      wheelStateRef.current = null;
    };
    const handleWheel = (event: WheelEvent) => {
      if (!clientRef.current?.getState().controlReady) return;
      // Trackpad pinches arrive as ctrl+wheel; don't turn them into scrolls.
      if (event.ctrlKey) return;
      // If the user is already touching/dragging (or holding Alt for the
      // two-finger gesture), let that win - don't add a second fake finger.
      if (isAltHeldRef.current || twoFingerStateRef.current) return;
      const pointerCount = activePointers.current.size;
      if (pointerCount > 1 || (pointerCount === 1 && !activePointers.current.has(WHEEL_POINTER_ID))) return;

      const ctx = computeVideoMappingContext();
      if (!ctx) return;
      // Outside the rendered video (frame, letterbox) let the page scroll.
      const relativeX = event.clientX - ctx.videoRect.left - ctx.offsetX;
      const relativeY = event.clientY - ctx.videoRect.top - ctx.offsetY;
      if (relativeX < 0 || relativeX > ctx.actualWidth || relativeY < 0 || relativeY > ctx.actualHeight) {
        return;
      }
      const anchor = mapClientPointToVideo(ctx, event.clientX, event.clientY);
      if (!anchor) return;
      event.preventDefault();

      // deltaMode: 0=pixels, 1=lines, 2=pages. Deltas are CSS pixels; convert
      // to stream pixels so a tick scrolls the same visual distance at any
      // window size.
      const scaleX =
        (event.deltaMode === 1 ? 16
        : event.deltaMode === 2 ? ctx.actualWidth
        : 1) *
        (ctx.videoWidth / ctx.actualWidth);
      const scaleY =
        (event.deltaMode === 1 ? 16
        : event.deltaMode === 2 ? ctx.actualHeight
        : 1) *
        (ctx.videoHeight / ctx.actualHeight);
      const dx = -event.deltaX * scaleX;
      const dy = -event.deltaY * scaleY;
      const armEnd = (s: { endTimer: number }) => {
        window.clearTimeout(s.endTimer);
        s.endTimer = window.setTimeout(endWheelGesture, WHEEL_END_QUIET_MS);
      };
      if (dx === 0 && dy === 0) {
        // Some wheel events carry no movement (momentum tails); just keep
        // the gesture alive.
        if (wheelStateRef.current) armEnd(wheelStateRef.current);
        return;
      }

      // Where to press the fake finger down: at the cursor, but nudged away
      // from the screen edges so the drag has room to travel.
      const pressPoint = (): PointerGeometry => ({
        videoWidth: anchor.videoWidth,
        videoHeight: anchor.videoHeight,
        videoX:
          Math.abs(dx) > Math.abs(dy) ?
            Math.min(Math.max(anchor.videoX, anchor.videoWidth * 0.2), anchor.videoWidth * 0.8)
          : anchor.videoX,
        videoY:
          Math.abs(dy) >= Math.abs(dx) ?
            Math.min(Math.max(anchor.videoY, anchor.videoHeight * 0.2), anchor.videoHeight * 0.8)
          : anchor.videoY,
      });

      const advance = (p: PointerGeometry): PointerGeometry => ({
        ...p,
        videoX: Math.min(Math.max(p.videoX + dx, 0), p.videoWidth),
        videoY: Math.min(Math.max(p.videoY + dy, 0), p.videoHeight),
      });

      let state = wheelStateRef.current;
      if (!state) {
        const start = pressPoint();
        applyPointerEvent(WHEEL_POINTER_ID, 'down', start);
        state = { pos: start, endTimer: 0 };
        wheelStateRef.current = state;
      } else {
        window.clearTimeout(state.endTimer);
      }

      let pos = state.pos;
      let next = advance(pos);
      if (next.videoX === pos.videoX && next.videoY === pos.videoY) {
        // Finger reached the screen edge: lift it, press again with room to
        // travel, and move right away (a press that never moves would count
        // as a tap).
        applyPointerEvent(WHEEL_POINTER_ID, 'up', pos);
        pos = pressPoint();
        applyPointerEvent(WHEEL_POINTER_ID, 'down', pos);
        next = advance(pos);
      }
      applyPointerEvent(WHEEL_POINTER_ID, 'move', next);
      state.pos = next;
      armEnd(state);
    };
    useEffect(() => {
      wheelCallbacksRef.current = { handle: handleWheel, end: endWheelGesture };
    });

    // React attaches onWheel passively, so preventDefault (needed to keep the
    // page from scrolling) requires a native non-passive listener. Cleanup
    // lifts an in-flight synthesized finger before the channel goes away.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const listener = (event: WheelEvent) => wheelCallbacksRef.current.handle(event);
      container.addEventListener('wheel', listener, { passive: false });
      return () => {
        wheelCallbacksRef.current.end();
        container.removeEventListener('wheel', listener);
      };
    }, []);

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
      const inputFocused =
        document.activeElement === videoRef.current ||
        (isDuo && document.activeElement === event.currentTarget);
      // Use the wrapper for conditional logging
      debugLog('Keyboard event:', {
        type: event.type,
        key: event.key,
        keyCode: event.keyCode,
        code: event.code,
        target: (event.target as HTMLElement).tagName,
        focused: inputFocused,
      });

      if (!inputFocused) {
        // Use the wrapper for conditional warning
        debugWarn('Simulator input not focused, skipping keyboard event');
        return;
      }

      if (!clientRef.current?.getState().controlReady) {
        // Use the wrapper for conditional warning
        debugWarn('Data channel not ready for keyboard event:', clientRef.current?.getState().connection);
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

    const handleManualRetry = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      clientRef.current?.reconnect();
    };
    const callbacksRef = useRef({
      onAxSnapshotChange,
      onAxStatusChange,
      onCameraDemandChange,
      onCameraStats,
      onMicrophoneStateChange,
      onTrace,
      onTerminated,
      onConnectionStateChange,
      onPlaybackStats,
    });
    callbacksRef.current = {
      onAxSnapshotChange,
      onAxStatusChange,
      onCameraDemandChange,
      onCameraStats,
      onMicrophoneStateChange,
      onTrace,
      onTerminated,
      onConnectionStateChange,
      onPlaybackStats,
    };
    const latencyTraceRequested = !!onTrace;
    useEffect(() => {
      lastVideoSize.current = null;
      setIsLandscape(false);
      setUseAndroidTabletFrame(false);
      setVideoStyle({});
    }, [url, deviceModel]);

    useEffect(() => {
      let active = true;
      if (axSnapshotRef.current !== null) {
        axSnapshotRef.current = null;
        setAxSnapshot(null);
        safeInvoke('onAxSnapshotChange', callbacksRef.current.onAxSnapshotChange, null);
      }
      const client = createDeviceStream({
        url,
        token,
        sessionId,
        watchOnly,
        deviceModel,
        autoReconnect,
        jitterBufferTargetMs,
        openUrl,
        inspectMode,
        axPollIntervalMs,
        axMaxBackoffMs,
        androidElementTreeOptions,
        microphoneEnabled,
        onStateChange: (state) => {
          // Preserve the loaded layout behind errors; the placeholder returns when a new attempt starts.
          if (
            state.videoReady ||
            state.connection === 'idle' ||
            state.connection === 'connecting' ||
            state.connection === 'reconnecting'
          )
            setVideoLoaded(state.videoReady);
          setRetryExhausted(state.connection === 'failed');
          setTerminated(state.connection === 'terminated');
          setDetectedDuo(state.duo);
          setDuoState(state.duoState);
          setDuoError(state.duoError);
        },
        onAxSnapshotChange: (snapshot) => {
          if (!active) return;
          setAxSnapshot((prev) => (axSnapshotsEqual(prev, snapshot) ? prev : snapshot));
          callbacksRef.current.onAxSnapshotChange?.(snapshot);
        },
        onAxStatusChange: (...args) => callbacksRef.current.onAxStatusChange?.(...args),
        onCameraDemandChange: (...args) => callbacksRef.current.onCameraDemandChange?.(...args),
        onCameraStats: onCameraStats ? (...args) => callbacksRef.current.onCameraStats?.(...args) : undefined,
        onMicrophoneStateChange: (...args) => callbacksRef.current.onMicrophoneStateChange?.(...args),
        onTrace: latencyTraceRequested ? (...args) => callbacksRef.current.onTrace?.(...args) : undefined,
        onTerminated: () => callbacksRef.current.onTerminated?.(),
        onConnectionStateChange: (...args) => callbacksRef.current.onConnectionStateChange?.(...args),
        onPlaybackStats:
          onPlaybackStats ? (...args) => callbacksRef.current.onPlaybackStats?.(...args) : undefined,
      });
      clientRef.current = client;
      const detach = videoRef.current ? client.attachVideo(videoRef.current) : undefined;
      client.start();
      return () => {
        active = false;
        client.dispose();
        detach?.();
        clientRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, token, propSessionId, deviceModel, latencyTraceRequested, watchOnly]);

    useEffect(() => {
      if (isDuo && innerVideoRef.current)
        return clientRef.current?.attachVideo(innerVideoRef.current, 'inner');
    }, [isDuo, url, token, propSessionId, deviceModel, latencyTraceRequested, watchOnly]);

    useEffect(() => {
      clientRef.current?.updateOptions({
        openUrl,
        axPollIntervalMs,
        axMaxBackoffMs,
        androidElementTreeOptions,
        autoReconnect,
        jitterBufferTargetMs,
        microphoneEnabled,
        inspectMode,
        onPlaybackStats:
          onPlaybackStats ? (...args) => callbacksRef.current.onPlaybackStats?.(...args) : undefined,
        onCameraStats: onCameraStats ? (...args) => callbacksRef.current.onCameraStats?.(...args) : undefined,
      });
    }, [
      autoReconnect,
      jitterBufferTargetMs,
      microphoneEnabled,
      inspectMode,
      !!onPlaybackStats,
      !!onCameraStats,
      openUrl,
      axPollIntervalMs,
      axMaxBackoffMs,
      androidElementTreeOptions,
    ]);

    // Recompute the inspect-overlay geometry (container-local pixel rect of
    // the actually-rendered video content) from the current mapping context.
    // The InfoCard places itself in viewport coordinates from pointer events
    // directly, so no viewport-space origin is needed in the geometry.
    const recomputeOverlayGeometry = () => {
      // Only the inspect overlay draws it, so resizes skip it until inspection starts.
      if (!inspectActiveRef.current) return;
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

      // A resize that leaves the style unchanged, such as a host panel widening around a
      // portrait stream, must not re-render the whole control.
      const updateVideoStyle = (next: React.CSSProperties) =>
        setVideoStyle((current) => (sameStyle(current, next) ? current : next));

      const updateVideoPosition = () => {
        const hasVideoSize = video.videoWidth > 0 && video.videoHeight > 0;
        if (hasVideoSize) lastVideoSize.current = { width: video.videoWidth, height: video.videoHeight };
        const size = lastVideoSize.current;
        const aspectRatio = size ? `${size.width} / ${size.height}` : undefined;
        // If no frame, just refresh overlay geometry; no inset/letterbox math
        // is needed since the video element is its own size.
        if (!frameVisible || !frame) {
          // Preserve intrinsic sizing after teardown releases the stream, including max-size constraints.
          updateVideoStyle(
            !hasVideoSize && size ?
              {
                aspectRatio,
                contain: 'size',
                containIntrinsicSize: `${size.width}px ${size.height}px`,
              }
            : {},
          );
          recomputeOverlayGeometry();
          return;
        }

        const frameWidth = frame.clientWidth;
        const frameHeight = frame.clientHeight;

        if (frameWidth === 0 || frameHeight === 0) return;

        // Determine landscape based on video's intrinsic dimensions
        const landscape = size ? size.width > size.height : false;
        setIsLandscape(landscape);
        setUseAndroidTabletFrame(
          platform === 'android' && !!size && isAndroidTabletVideo(size.width, size.height),
        );

        const pos = landscape ? config.videoPosition.landscape : config.videoPosition.portrait;
        let newStyle: React.CSSProperties = { aspectRatio };
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
        updateVideoStyle(newStyle);
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
      const bumpOnResize = () => clientRef.current?.bumpActivity();
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
    }, [config, frameVisible, url, deviceModel]);

    // Reset overlay selection when inspection is disabled; place the overlay when it starts.
    useEffect(() => {
      if (inspectActive) {
        recomputeOverlayGeometry();
      } else {
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
      openUrl: (url) => clientRef.current?.openUrl(url),
      sendKeyEvent: (event) => clientRef.current?.sendKeyEvent(event),
      screenshot: (display) =>
        clientRef.current?.screenshot(display) ?? Promise.reject(new Error('Simulator disconnected')),
      terminateApp: (bundleId) =>
        clientRef.current?.terminateApp(bundleId) ?? Promise.reject(new Error('Simulator disconnected')),
      reconnect: () => clientRef.current?.reconnect(),
      refreshAxTree: () =>
        clientRef.current?.refreshAxTree() ?? Promise.reject(new Error('Simulator disconnected')),
      getAxSnapshot: () => clientRef.current?.getAxSnapshot() ?? null,

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

      getAxStatus: () => clientRef.current?.getAxStatus() ?? 'idle',
    }));

    // Show indicators when Alt is held and we have a valid hover point (null when outside)
    const showAltIndicators = isAltHeld && hoverPoint !== null;

    return (
      <div
        ref={containerRef}
        className={['rc-container', className].filter(Boolean).join(' ')}
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
        {frameVisible && (
          <img
            ref={frameRef}
            src={frameImageSrc}
            alt=""
            className={platform === 'ios' ? 'rc-phone-frame rc-phone-frame-ios' : 'rc-phone-frame'}
            draggable={false}
          />
        )}
        <video
          ref={videoRef}
          className={['rc-video', !frameVisible && 'rc-video-frameless', !videoLoaded && 'rc-video-loading']
            .filter(Boolean)
            .join(' ')}
          style={{
            ...videoStyle,
            ...(isDuo ? { opacity: 0, width: 1, height: 1, pointerEvents: 'none' as const } : {}),
            ...(loadingLogo ?
              {
                backgroundImage: `url("${loadingLogo}")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundSize: config.loadingLogoSize,
              }
            : {}),
          }}
          autoPlay
          playsInline
          muted
          tabIndex={isDuo ? -1 : 0}
          onKeyDown={handleKeyboard}
          onKeyUp={handleKeyboard}
          onClick={handleVideoClick}
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
        {isDuo && (
          <video
            ref={innerVideoRef}
            autoPlay
            playsInline
            muted
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          />
        )}
        {isDuo && duoState && (
          <Suspense fallback={<div>Loading iPhone Duo…</div>}>
            <DuoView
              watchOnly={watchOnly}
              showFrame={showFrame}
              modelUrl={duoModelUrl}
              outer={videoRef.current}
              inner={innerVideoRef.current}
              state={duoState}
              setAngle={(angleDegrees) => sendDuoControl('setHingeAngle', { angleDegrees })}
              setOrientation={(orientation: DuoOrientation) =>
                sendDuoControl('setDuoOrientation', { orientation })
              }
              button={(button, down) =>
                sendDuoControl('performActions', {
                  actions: [{ type: down ? 'buttonDown' : 'buttonUp', button }],
                })
              }
              touch={(action, screenId, x, y) => {
                clientRef.current?.sendDisplayTouch(action, screenId, x, y);
              }}
              onKeyDown={handleKeyboard}
              onKeyUp={handleKeyboard}
            />
          </Suspense>
        )}
        {isDuo && duoError && (
          <div role="alert" className="rc-duo-error">
            {duoError}
          </div>
        )}
        {!isDuo && inspectActive && (
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
            onTapElement={
              watchOnly ? undefined : (
                (element, tapAt) => {
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
                }
              )
            }
          />
        )}
        {terminated ?
          <div className="rc-terminated" role="status">
            <div className="rc-terminated-title">Instance terminated</div>
            <div className="rc-terminated-message">
              This instance no longer exists and can&apos;t be reconnected.
            </div>
          </div>
        : retryExhausted && (
            <button type="button" className="rc-retry-button" onClick={handleManualRetry}>
              Retry
            </button>
          )
        }
      </div>
    );
  },
);
