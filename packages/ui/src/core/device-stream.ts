import { ANDROID_KEYS, codeMap } from './constants';
import {
  createInjectKeycodeMessage,
  createTouchControlMessage,
  createSetClipboardMessage,
} from './webrtc-messages';
import { createDisplayTouchMessage, type DuoState } from './duo';
import { AxFetcher } from './ax-fetcher';
import type { AxSnapshot } from './ax-tree';
import { applyJitterBufferTarget } from './jitter-buffer';
import { attachVideoStream } from './video-playback';
import { subscribePlaybackStats, type PlaybackConnection } from './playback-subscription';
import { createLatencyTrace } from './latency-trace';
import {
  CameraOperationCoordinator,
  cameraCaptureConstraints,
  createGrantedCameraResult,
  shouldReacquireCamera,
  parseCameraRequest,
  type CameraRequest,
} from './camera';
import { debugLog, debugWarn, safeInvoke, detectPlatform, withAuthenticationToken } from './stream-utils';
import type {
  CameraStreamStats,
  ScreenshotData,
  ImperativeKeyboardEvent,
  RemoteControlConnectionState,
} from './stream-types';
import type {
  DeviceStreamOptions,
  DeviceStreamLiveOptions,
  DeviceStreamState,
  StreamDisplay,
  DeviceFrameSink,
} from './stream-options';

const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_RETRY_DELAY_MS = 1000;
const CONNECTION_SUCCESS_TIMEOUT_MS = 15000;
const ICE_DISCONNECTED_GRACE_MS = 3000;
const TERMINATION_PROBE_TIMEOUT_MS = 4000;

// Hosts such as T3 serve LAN clients over HTTP, where randomUUID is unavailable.
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A browser session shared by RemoteControl and custom renderers. No React or CSS required. */
export function createDeviceStream(initialOptions: DeviceStreamOptions) {
  let options = { ...initialOptions };
  const { url, token, deviceModel } = options;
  const sessionId = options.sessionId ?? requestId();
  const platform = options.platform ?? detectPlatform(url ?? '');
  let state: DeviceStreamState = {
    connection: 'idle',
    videoReady: false,
    controlReady: false,
    duo: false,
    duoState: null,
  };
  const updateState = (patch: Partial<DeviceStreamState>) => {
    state = { ...state, ...patch };
    safeInvoke('onStateChange', options.onStateChange, state);
  };
  const setVideoLoaded = (videoReady: boolean) => updateState({ videoReady });
  const setDuoState = (duoState: DuoState | null) => updateState({ duoState });
  const setDuoError = (duoError: string | undefined) => updateState({ duoError });
  const setDetectedDuo = (duo: boolean) => updateState({ duo });
  const updateStatus = (message: string) => debugLog(message);
  let playbackConnection: PlaybackConnection | null = null;
  let stopPlaybackStats: (() => void) | undefined;
  const refreshPlaybackStats = () => {
    stopPlaybackStats?.();
    stopPlaybackStats =
      playbackConnection && options.onPlaybackStats ?
        subscribePlaybackStats(
          playbackConnection,
          () => options.onPlaybackStats,
          () => options.jitterBufferTargetMs,
        )
      : undefined;
  };
  type VideoEntry = { display: StreamDisplay; stop?: () => void; clear?: () => void };
  const videos = new Map<HTMLVideoElement, VideoEntry>();
  const attachments = new Set<() => void>();
  const pendingWaits = new Set<() => void>();
  const requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  const streams = new Map<StreamDisplay, MediaStream>();
  const playVideo = (video: HTMLVideoElement, entry: VideoEntry, stream: MediaStream) => {
    entry.stop?.();
    entry.stop = attachVideoStream(video, stream, (error) => debugWarn('Video playback fallback:', error));
  };
  const clearPlayback = () => {
    streams.clear();
    for (const [video, entry] of videos) {
      entry.clear?.();
      entry.stop?.();
      entry.stop = undefined;
      video.srcObject = null;
    }
  };
  let currentTerminated = false;
  // Guards against firing overlapping termination probes.
  let currentTerminationProbeInFlight = false;
  // Retries belong to one lifecycle; explicit start/stop invalidates its outstanding probes.
  let lifecycleGeneration = 0;
  let currentWs: WebSocket | null = null;
  let currentPeerConnection: RTCPeerConnection | null = null;
  let currentDataChannel: RTCDataChannel | null = null;
  let currentLatencyTrace: ReturnType<typeof createLatencyTrace> | null = null;
  let currentKeepAliveInterval: number | undefined = undefined;
  let currentRetryTimeout: number | undefined = undefined;
  let currentConnectionSuccessTimeout: number | undefined = undefined;
  let currentRequestFrameInterval: number | undefined = undefined;
  let currentIceDisconnectedGrace: number | undefined = undefined;
  let currentConnectionGeneration = 0;
  let currentConnectionAttempt = 0;
  let currentControlChannelOpened = false;
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
  // Keep both the sender and stream so teardown releases camera capture.
  let currentOutboundCameraSender: RTCRtpSender | null = null;
  let currentOutboundLocalStream: MediaStream | null = null;
  let currentOutboundCameraRequest: CameraRequest | undefined = undefined;
  const cameraOperations = new CameraOperationCoordinator();
  // updateOptions keeps callbacks current without renegotiating the connection.
  // Active outbound-camera stats poller. While the camera is
  // sending we sample `RTCPeerConnection.getStats()` once per
  // second, derive deltas (bitrate, fps, packet loss) from the
  // previous sample, and push the result through `onCameraStats`.
  // Cleared on teardown so we never leak the timer.
  let currentCameraStatsTimer: ReturnType<typeof setInterval> | null = null;
  let currentCameraStatsPrev: {
    timestamp: number;
    framesEncoded?: number;
    bytesSent?: number;
    packetsSent?: number;
    packetsLost?: number;
  } | null = null;
  // Outbound microphone state (iOS only). The manual option and guest-driven
  // microphoneRequest signals share one pre-allocated audio transceiver.
  let currentMicrophoneEnabled = options.microphoneEnabled ?? false;
  let currentMicrophoneDemandActive = false;
  let currentOutboundMicSender: RTCRtpSender | null = null;
  let currentOutboundMicStream: MediaStream | null = null;
  // Bumped by detach and teardown so an attach suspended on an await
  // (the getUserMedia prompt) detects it was superseded and bails.
  let currentMicGeneration = 0;
  // Serializes attach/detach work so their awaits (replaceTrack on the
  // shared sender) can never interleave and undo each other's effects.
  let currentMicOpQueue: Promise<void> = Promise.resolve();
  // Correlates the in-flight `microphoneStart` with its result so a
  // host-side rejection (e.g. no loopback device on the node) can
  // tear the capture back down and surface the error.
  let currentMicStartPendingId: string | null = null;
  let currentFirstFrameShown = false;
  let currentPendingScreenshotResolvers: Map<
    string,
    (value: ScreenshotData | PromiseLike<ScreenshotData>) => void
  > = new Map();
  let currentPendingScreenshotRejecters: Map<string, (reason?: any) => void> = new Map();
  let currentPendingTerminateAppResolvers: Map<string, () => void> = new Map();
  let currentPendingTerminateAppRejecters: Map<string, (reason?: any) => void> = new Map();

  let currentAxFetcher: AxFetcher | null = null;
  let currentAxSnapshot: AxSnapshot | null = null;
  let axSnapshotRevision = 0;
  const publishAxSnapshot = (snapshot: AxSnapshot | null) => {
    currentAxSnapshot = snapshot;
    const revision = ++axSnapshotRevision;
    // Defer customer code until cleanup completes. A newer snapshot supersedes queued delivery.
    queueMicrotask(() => {
      if (revision === axSnapshotRevision)
        safeInvoke('onAxSnapshotChange', options.onAxSnapshotChange, snapshot);
    });
  };
  let currentConnectionState: RemoteControlConnectionState | null = null;
  let currentDuoRequests = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const sendDuoControl = (type: string, parameters: object): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = currentWs;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Simulator disconnected'));
        return;
      }
      const id = requestId();
      const timer = setTimeout(() => {
        currentDuoRequests.delete(id);
        reject(new Error('Device control timed out'));
      }, 5000);
      currentDuoRequests.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type, id, ...parameters }));
    });
  const reportConnectionState = (next: RemoteControlConnectionState) => {
    if (currentConnectionState === next) return;
    currentConnectionState = next;
    updateState({ connection: next });
    safeInvoke('onConnectionStateChange', options.onConnectionStateChange, next);
  };

  const sendBinaryControlMessage = (data: ArrayBuffer) => {
    if (!currentDataChannel || currentDataChannel.readyState !== 'open') {
      return;
    }
    currentDataChannel.send(currentLatencyTrace?.wrap(data) ?? data);
    // Any binary control message is an input event. Bump the AX poller so
    // we get a fresh snapshot quickly — the UI almost certainly changed.
    currentAxFetcher?.bumpActivity();
  };

  const sendKeepAlive = () => {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(
        JSON.stringify({
          type: 'keepAlive',
          sessionId: sessionId,
        }),
      );
    }
  };

  const startKeepAlive = () => {
    if (currentKeepAliveInterval) {
      window.clearInterval(currentKeepAliveInterval);
    }
    currentKeepAliveInterval = window.setInterval(sendKeepAlive, 10000);
  };

  const stopKeepAlive = () => {
    if (currentKeepAliveInterval) {
      window.clearInterval(currentKeepAliveInterval);
      currentKeepAliveInterval = undefined;
    }
  };

  const clearScheduledRetry = () => {
    if (currentRetryTimeout) {
      window.clearTimeout(currentRetryTimeout);
      currentRetryTimeout = undefined;
    }
  };

  const clearConnectionSuccessTimeout = () => {
    if (currentConnectionSuccessTimeout) {
      window.clearTimeout(currentConnectionSuccessTimeout);
      currentConnectionSuccessTimeout = undefined;
    }
  };

  const stopRequestFrameLoop = () => {
    if (currentRequestFrameInterval) {
      window.clearInterval(currentRequestFrameInterval);
      currentRequestFrameInterval = undefined;
    }
  };

  const clearIceDisconnectedGrace = () => {
    if (currentIceDisconnectedGrace !== undefined) {
      window.clearTimeout(currentIceDisconnectedGrace);
      currentIceDisconnectedGrace = undefined;
    }
  };

  const markFirstFrameShown = () => {
    if (currentFirstFrameShown) {
      return;
    }
    currentFirstFrameShown = true;
    stopRequestFrameLoop();
    setVideoLoaded(true);
    reportConnectionState('connected');
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
    const stream = currentOutboundLocalStream;
    if (!stream) return;
    currentOutboundLocalStream = null;
    stopMediaStream(stream);
  };

  // Runs one attach/detach operation after all previously queued ones,
  // so two operations' awaits never interleave on the shared sender (a
  // stale detach could otherwise clear a fresh attach's track, or send
  // `microphoneStop` after its `microphoneStart`).
  const runMicOp = (op: () => Promise<void>): Promise<void> => {
    const next = currentMicOpQueue.then(op).catch((err) => {
      debugWarn('microphone operation failed:', err);
    });
    currentMicOpQueue = next;
    return next;
  };

  const isMicrophoneWanted = () => currentMicrophoneEnabled || currentMicrophoneDemandActive;

  const sendMicrophoneStart = (ws: WebSocket) => {
    const id = `ui-mic-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    currentMicStartPendingId = id;
    ws.send(JSON.stringify({ type: 'microphoneStart', id }));
  };

  // Capture the user's microphone and stream it to the simulator's
  // mock microphone. Safe to call redundantly: bails when already
  // attached, when the connection isn't up yet (the ICE-connected
  // handler re-invokes it), or when capture was disabled mid-prompt.
  // Does NOT bump the generation: a redundant call (e.g. the ICE
  // handler firing on both `connected` and `completed`) must not
  // cancel an attach already in flight; only detach/teardown cancel.
  const attachMicrophone = (): Promise<void> => {
    // No platform gate: attachMicrophoneOp bails when the session never
    // allocated a sendonly mic transceiver (non-capable servers).
    return runMicOp(() => attachMicrophoneOp());
  };

  const attachMicrophoneOp = async () => {
    const generation = currentMicGeneration;
    const isCurrent = () => generation === currentMicGeneration && isMicrophoneWanted();
    const reportMicError = (error: string) => {
      safeInvoke('onMicrophoneStateChange', options.onMicrophoneStateChange, {
        active: false,
        error,
      });
    };
    if (!isCurrent()) return;
    const ws = currentWs;
    const sender = currentOutboundMicSender;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sender) {
      // Not connected yet — the post-connect hook retries while the
      // option is still on.
      return;
    }
    if (currentOutboundMicStream) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      console.warn(
        '[RemoteControl] navigator.mediaDevices.getUserMedia unavailable. ' +
          'getUserMedia requires a secure context (https or http://localhost).',
      );
      reportMicError('Microphone capture requires a secure context (https)');
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      console.warn('[RemoteControl] microphone getUserMedia denied/failed:', err);
    }
    if (!isCurrent()) {
      if (stream) stopMediaStream(stream);
      return;
    }
    if (!stream) {
      reportMicError('Microphone permission denied or no device available');
      return;
    }
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    if (!audioTrack) {
      stopMediaStream(stream);
      reportMicError('Captured stream has no audio track');
      return;
    }
    try {
      await sender.replaceTrack(audioTrack);
    } catch (err) {
      debugWarn('replaceTrack(audioTrack) failed:', err);
      stopMediaStream(stream);
      reportMicError('Failed to attach the microphone track to the connection');
      return;
    }
    if (!isCurrent()) {
      try {
        await sender.replaceTrack(null);
      } catch (err) {
        debugWarn('replaceTrack(null) on stale mic attach failed:', err);
      }
      stopMediaStream(stream);
      return;
    }
    currentOutboundMicStream = stream;
    // If the browser revokes the track later (user clicks Stop in
    // the tab's mic indicator, device unplugged, ...) tear down and
    // tell the host, so the sim's mic goes back to silence instead
    // of freezing on the last buffer.
    audioTrack.onended = () => {
      if (currentOutboundMicStream !== stream) return;
      void detachMicrophone('microphone capture ended by the browser');
    };
    sendMicrophoneStart(ws);
    safeInvoke('onMicrophoneStateChange', options.onMicrophoneStateChange, {
      active: true,
      label: audioTrack.label || undefined,
    });
  };

  // Stop the live microphone: drop the track from the sender, stop
  // the capture (turning the browser's mic indicator off) and tell
  // the host to switch its audio source back to silence. Safe to
  // call when nothing is attached.
  const detachMicrophone = (error?: string): Promise<void> => {
    // Bump synchronously (not on the queue) so an attach that is
    // suspended on an await bails at its next checkpoint even while
    // it still owns the queue.
    ++currentMicGeneration;
    currentMicStartPendingId = null;
    return runMicOp(async () => {
      const sender = currentOutboundMicSender;
      const stream = currentOutboundMicStream;
      currentOutboundMicStream = null;
      if (sender && stream) {
        try {
          await sender.replaceTrack(null);
        } catch (err) {
          debugWarn('replaceTrack(null) on mic detach failed:', err);
        }
      }
      if (stream) stopMediaStream(stream);
      const ws = currentWs;
      if (stream && ws && ws.readyState === WebSocket.OPEN) {
        const id = `ui-mic-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        ws.send(JSON.stringify({ type: 'microphoneStop', id }));
      }
      if (stream || error) {
        safeInvoke('onMicrophoneStateChange', options.onMicrophoneStateChange, {
          active: false,
          ...(error !== undefined && { error }),
        });
      }
    });
  };

  // Publish a fresh settings snapshot after every successful capture
  // change. This is status metadata; host output sizing is frame-derived.
  const sendGrantedCameraResult = (ws: WebSocket, videoTrack: MediaStreamTrack) => {
    let result;
    try {
      result = createGrantedCameraResult(videoTrack);
      console.info(
        `[RemoteControl] camera capture: ${result.camera?.width}x${result.camera?.height}` +
          ` @ ${result.camera?.frameRate ?? '?'}fps` +
          (result.camera?.label ? ` — ${result.camera.label}` : ''),
      );
    } catch (err) {
      debugWarn('getSettings() on outbound camera track failed:', err);
      result = {
        type: 'cameraResult' as const,
        granted: true,
        camera: {
          label: videoTrack.label || undefined,
        },
      };
    }
    ws.send(JSON.stringify(result));
    safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, true, result.camera);
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
    const sender = currentOutboundCameraSender;
    const handler = options.onCameraStats;
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
    const prev = currentCameraStatsPrev;
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
    currentCameraStatsPrev = {
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
    safeInvoke('onCameraStats', options.onCameraStats, stats);
  };

  const startCameraStatsPoller = () => {
    if (currentCameraStatsTimer !== null) return;
    currentCameraStatsPrev = null;
    // First sample fires after one interval — the very first
    // sample has no deltas to compare against, which is fine: the
    // codec/encoder identity is still useful on its own.
    currentCameraStatsTimer = setInterval(() => {
      void sampleOutboundCameraStats();
    }, 1000);
  };

  const stopCameraStatsPoller = () => {
    if (currentCameraStatsTimer !== null) {
      clearInterval(currentCameraStatsTimer);
      currentCameraStatsTimer = null;
    }
    currentCameraStatsPrev = null;
    safeInvoke('onCameraStats', options.onCameraStats, null);
  };

  const handleCameraRequest = (
    request: CameraRequest,
    ws: WebSocket,
    sender: RTCRtpSender,
    isCurrentAttempt: () => boolean,
  ): Promise<void> => {
    // `enqueue` increments its generation synchronously, so suspended
    // permission work becomes stale before the newer operation starts.
    return cameraOperations.enqueue(async ({ isCurrent }) => {
      const isCurrentCameraRequest = () =>
        isCurrent() && isCurrentAttempt() && currentWs === ws && currentOutboundCameraSender === sender;
      if (!isCurrentCameraRequest()) return;

      if (!request.active) {
        const stream = currentOutboundLocalStream;
        try {
          await sender.replaceTrack(null);
        } catch (err) {
          debugWarn('replaceTrack(null) on camera detach failed:', err);
        }
        if (currentOutboundLocalStream === stream) {
          currentOutboundLocalStream = null;
          currentOutboundCameraRequest = undefined;
          if (stream) stopMediaStream(stream);
        }
        stopCameraStatsPoller();
        if (!isCurrentCameraRequest()) return;
        safeInvoke('onCameraDemandChange', options.onCameraDemandChange, false);
        return;
      }

      safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true);
      const currentStream = currentOutboundLocalStream;
      const currentTrack = currentStream?.getVideoTracks()[0];
      const currentRequest = currentOutboundCameraRequest;

      if (
        currentTrack?.readyState === 'live' &&
        currentRequest &&
        !shouldReacquireCamera(currentRequest, request)
      ) {
        currentOutboundCameraRequest = request;
        sendGrantedCameraResult(ws, currentTrack);
        startCameraStatsPoller();
        return;
      }

      // A facing change always restarts browser capture. Releasing first
      // lets mobile browsers open the opposite camera; one-camera laptops
      // naturally return the same available input for the new ideal.
      if (currentStream) {
        try {
          await sender.replaceTrack(null);
        } catch (err) {
          debugWarn('replaceTrack(null) before camera switch failed:', err);
        }
        if (currentOutboundLocalStream === currentStream) {
          currentOutboundLocalStream = null;
          currentOutboundCameraRequest = undefined;
          stopMediaStream(currentStream);
        }
        stopCameraStatsPoller();
        if (!isCurrentCameraRequest()) return;
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        console.warn(
          '[RemoteControl] navigator.mediaDevices.getUserMedia unavailable. ' +
            'getUserMedia requires a secure context (https or http://localhost). ' +
            'Replying cameraResult granted=false so limulator falls back to black frames.',
        );
        if (!isCurrentCameraRequest()) return;
        ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
        safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, false);
        return;
      }

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraCaptureConstraints(request),
          audio: false,
        });
      } catch (err) {
        console.warn('[RemoteControl] getUserMedia denied/failed:', err);
      }
      if (!isCurrentCameraRequest()) {
        if (stream) stopMediaStream(stream);
        return;
      }
      if (!stream) {
        ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
        safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, false);
        return;
      }

      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) {
        stopMediaStream(stream);
        if (!isCurrentCameraRequest()) return;
        ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
        safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, false);
        return;
      }

      try {
        videoTrack.contentHint = 'motion';
      } catch {
        /* older browsers don't support contentHint; ignore */
      }

      try {
        await sender.replaceTrack(videoTrack);
      } catch (err) {
        debugWarn('replaceTrack(videoTrack) failed:', err);
        stopMediaStream(stream);
        if (!isCurrentCameraRequest()) return;
        ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
        safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, false);
        return;
      }
      if (!isCurrentCameraRequest()) {
        try {
          await sender.replaceTrack(null);
        } catch (err) {
          debugWarn('replaceTrack(null) for stale camera attach failed:', err);
        }
        stopMediaStream(stream);
        return;
      }

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
      if (!isCurrentCameraRequest()) {
        try {
          await sender.replaceTrack(null);
        } catch (err) {
          debugWarn('replaceTrack(null) for stale camera finalize failed:', err);
        }
        stopMediaStream(stream);
        return;
      }

      currentOutboundLocalStream = stream;
      currentOutboundCameraRequest = request;

      videoTrack.onended = () => {
        if (currentOutboundLocalStream !== stream) return;
        void cameraOperations
          .enqueueCurrent(async ({ isCurrent: isCurrentEndedCleanup }) => {
            if (
              !isCurrentEndedCleanup() ||
              currentOutboundLocalStream !== stream ||
              !isCurrentAttempt() ||
              currentWs !== ws ||
              currentOutboundCameraSender !== sender
            ) {
              return;
            }
            try {
              await sender.replaceTrack(null);
            } catch (err) {
              debugWarn('replaceTrack(null) after camera ended failed:', err);
            }
            if (
              !isCurrentEndedCleanup() ||
              currentOutboundLocalStream !== stream ||
              !isCurrentAttempt() ||
              currentWs !== ws ||
              currentOutboundCameraSender !== sender
            ) {
              return;
            }
            currentOutboundLocalStream = null;
            currentOutboundCameraRequest = undefined;
            stopMediaStream(stream);
            stopCameraStatsPoller();
            ws.send(JSON.stringify({ type: 'cameraResult', granted: false }));
            safeInvoke('onCameraDemandChange', options.onCameraDemandChange, true, false);
          })
          .catch((err) => debugWarn('camera ended cleanup failed:', err));
      };

      if (!isCurrentCameraRequest()) return;
      sendGrantedCameraResult(ws, videoTrack);
      startCameraStatsPoller();
    });
  };

  const teardownConnection = () => {
    for (const cancel of pendingWaits) cancel();
    pendingWaits.clear();
    for (const timer of requestTimers.values()) clearTimeout(timer);
    requestTimers.clear();
    for (const reject of currentPendingScreenshotRejecters.values())
      reject(new Error('Simulator disconnected'));
    for (const reject of currentPendingTerminateAppRejecters.values())
      reject(new Error('Simulator disconnected'));
    currentPendingScreenshotRejecters.clear();
    currentPendingScreenshotResolvers.clear();
    currentPendingTerminateAppRejecters.clear();
    currentPendingTerminateAppResolvers.clear();
    stopPlaybackStats?.();
    stopPlaybackStats = undefined;
    clearPlayback();
    playbackConnection = null;
    for (const request of currentDuoRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Simulator disconnected'));
    }
    currentDuoRequests.clear();
    setDuoState(null);
    updateState({ controlReady: false, videoReady: false });

    clearConnectionSuccessTimeout();
    clearIceDisconnectedGrace();
    stopRequestFrameLoop();
    if (currentAxFetcher) {
      currentAxFetcher.stop();
      currentAxFetcher = null;
    }
    if (currentAxSnapshot !== null) publishAxSnapshot(null);
    // Drop any active outbound camera before the PC dies so the
    // browser doesn't leave the camera indicator lit between
    // reconnects.
    cameraOperations.invalidate();
    stopCameraStatsPoller();
    stopOutboundLocalStream();
    currentOutboundCameraRequest = undefined;
    currentOutboundCameraSender = null;
    // Same for the live microphone. Manual enablement survives reconnect;
    // guest demand is replayed by the host after it assigns the new session.
    ++currentMicGeneration;
    currentMicrophoneDemandActive = false;
    currentMicStartPendingId = null;
    if (currentOutboundMicStream) {
      stopMediaStream(currentOutboundMicStream);
      currentOutboundMicStream = null;
      // The capture is gone; report it so consumers don't keep a stale
      // `active: true` across drops (a re-attach after reconnect
      // reports again).
      safeInvoke('onMicrophoneStateChange', options.onMicrophoneStateChange, {
        active: false,
      });
    }
    currentOutboundMicSender = null;
    if (currentWs) {
      currentWs.onopen = null;
      currentWs.onmessage = null;
      currentWs.onerror = null;
      currentWs.onclose = null;
      currentWs.close();
      currentWs = null;
    }
    currentLatencyTrace?.close();
    currentLatencyTrace = null;
    if (currentPeerConnection) {
      currentPeerConnection.onconnectionstatechange = null;
      currentPeerConnection.oniceconnectionstatechange = null;
      currentPeerConnection.ontrack = null;
      currentPeerConnection.onicecandidate = null;
      currentPeerConnection.close();
      currentPeerConnection = null;
    }
    if (currentDataChannel) {
      currentDataChannel.onopen = null;
      currentDataChannel.onclose = null;
      currentDataChannel.onerror = null;
      currentDataChannel.close();
      currentDataChannel = null;
    }
  };

  const handleVisibilityChange = () => {
    if (document.hidden) {
      stopKeepAlive();
    } else {
      startKeepAlive();
    }
  };

  // Probe the instance endpoint over HTTP to tell a permanent termination
  // apart from a recoverable connection drop. The router serves the same
  // path the WebSocket uses and returns 404 once the instance is gone
  // (deleted / terminated), while a live instance returns something else.
  //
  // Only an authoritative, freshly-fetched 404 counts as terminated. A
  // network outage, a non-404 status, or a CORS-blocked (unreadable)
  // response all resolve to `false` so we keep the normal retry/reconnect
  // behavior and never mistake a connectivity problem for a termination.
  const probeTerminated = async (): Promise<boolean> => {
    if (options.transport) return options.transport.isTerminated?.() ?? false;
    // The browser knows it has no network — this is a connectivity drop,
    // not a termination. Don't probe (and don't risk a cached 404).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }
    let probeUrl: string;
    try {
      const parsed = new URL(url!);
      parsed.protocol =
        parsed.protocol === 'wss:' ? 'https:'
        : parsed.protocol === 'ws:' ? 'http:'
        : parsed.protocol;
      probeUrl = withAuthenticationToken(parsed.toString(), token!);
    } catch {
      return false;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), TERMINATION_PROBE_TIMEOUT_MS);
    try {
      // `no-store` so a prior response can't be served from the HTTP cache
      // (e.g. a stale 404 returned while offline would look like a
      // termination); the probe must always reach the live router.
      const res = await fetch(probeUrl, { method: 'GET', cache: 'no-store', signal: controller.signal });
      return res.status === 404;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const markTerminated = () => {
    if (currentTerminated) return;
    currentTerminated = true;

    // Invalidate any in-flight/scheduled attempt and stop all activity so
    // we don't keep hammering an endpoint that will never come back.
    currentConnectionGeneration += 1;
    clearScheduledRetry();
    clearConnectionSuccessTimeout();
    clearIceDisconnectedGrace();
    teardownConnection();
    updateStatus('Instance terminated');
    stopKeepAlive();
    reportConnectionState('terminated');
    safeInvoke('onTerminated', options.onTerminated);
  };

  // Run a one-shot termination check in reaction to a drop. Event-driven
  // (no polling), deduped while one is already in flight, and a no-op once
  // we've concluded the instance is gone.
  const checkTerminated = () => {
    if (currentTerminated || currentTerminationProbeInFlight) return;
    currentTerminationProbeInFlight = true;
    const generation = lifecycleGeneration;
    void probeTerminated()
      .catch(() => false)
      .then((isTerminated) => {
        if (generation !== lifecycleGeneration) return;
        currentTerminationProbeInFlight = false;
        if (isTerminated) {
          markTerminated();
        }
      });
  };

  const scheduleRetry = (reason: string, generation: number) => {
    if (currentTerminated) {
      return;
    }
    if (generation !== currentConnectionGeneration) {
      return;
    }

    // A drop just happened. Find out whether the instance is gone for good
    // (404) rather than a recoverable blip; if so the probe stops retries
    // and surfaces the terminated message. Meanwhile the normal retry path
    // below proceeds and is short-circuited once the verdict lands.
    checkTerminated();

    if (currentControlChannelOpened) {
      if (!options.autoReconnect) {
        updateStatus(`Connection failed after it was established: ${reason}`);

        stopKeepAlive();
        reportConnectionState('failed');
        teardownConnection();
        return;
      }
      // Reset so the upcoming retry gets a fresh MAX_CONNECTION_ATTEMPTS budget.
      updateStatus(`Reconnecting after established session dropped: ${reason}`);
      currentControlChannelOpened = false;
      currentConnectionAttempt = -1;
    }

    clearScheduledRetry();

    const nextAttempt = currentConnectionAttempt + 1;
    if (nextAttempt >= MAX_CONNECTION_ATTEMPTS) {
      updateStatus(`Connection failed after ${MAX_CONNECTION_ATTEMPTS} attempts: ${reason}`);

      stopKeepAlive();
      reportConnectionState('failed');
      teardownConnection();
      return;
    }

    updateStatus(`Retrying connection (${nextAttempt + 1}/${MAX_CONNECTION_ATTEMPTS})`);
    reportConnectionState('reconnecting');
    teardownConnection();
    currentRetryTimeout = window.setTimeout(() => {
      currentRetryTimeout = undefined;
      if (generation !== currentConnectionGeneration) {
        return;
      }
      void startAttempt(nextAttempt);
    }, CONNECTION_RETRY_DELAY_MS);
  };

  const startAttempt = async (attemptNumber = 0) => {
    const { openUrl, axPollIntervalMs, axMaxBackoffMs, androidElementTreeOptions } = options;
    // Never reconnect to an instance we've concluded is gone. `start()`
    // clears this when a deliberate fresh connection is requested.
    if (currentTerminated) return;
    const generation = currentConnectionGeneration + 1;
    currentConnectionGeneration = generation;
    currentConnectionAttempt = attemptNumber;
    currentControlChannelOpened = false;

    // A drop after an established session restarts the attempt budget at 0
    // while staying 'reconnecting'; only a fresh start reports 'connecting'.
    if (attemptNumber === 0 && currentConnectionState !== 'reconnecting') reportConnectionState('connecting');
    clearScheduledRetry();
    clearConnectionSuccessTimeout();
    stopRequestFrameLoop();
    currentFirstFrameShown = false;
    setVideoLoaded(false);
    teardownConnection();

    const isCurrentAttempt = () => generation === currentConnectionGeneration;

    currentConnectionSuccessTimeout = window.setTimeout(() => {
      currentConnectionSuccessTimeout = undefined;
      if (!isCurrentAttempt() || currentControlChannelOpened) {
        return;
      }
      scheduleRetry('Connection did not succeed within 15 seconds', generation);
    }, CONNECTION_SUCCESS_TIMEOUT_MS);

    try {
      const ws =
        options.transport ?
          await options.transport.connect()
        : new WebSocket(withAuthenticationToken(url!, token!));
      if (!isCurrentAttempt()) {
        ws.close();
        return;
      }
      currentWs = ws;

      // Wait for WebSocket to connect
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cancel = () => settle(() => reject(new Error('Connection stopped')));
        pendingWaits.add(cancel);
        const timeoutId = window.setTimeout(
          () => settle(() => reject(new Error('WebSocket connection timeout'))),
          30000,
        );
        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingWaits.delete(cancel);
          window.clearTimeout(timeoutId);
          callback();
        };

        ws.onopen = () => {
          if (!isCurrentAttempt() || currentWs !== ws) {
            return;
          }
          settle(resolve);
        };

        ws.onerror = (error) => {
          if (!isCurrentAttempt() || currentWs !== ws) {
            return;
          }
          updateStatus('WebSocket error: ' + error);
          settle(() => reject(new Error('WebSocket connection failed')));
        };

        ws.onclose = () => {
          if (!isCurrentAttempt() || currentWs !== ws) {
            return;
          }
          updateStatus('WebSocket closed');
          settle(() => reject(new Error('WebSocket closed before connection was established')));
        };
        if (ws.readyState === WebSocket.OPEN) settle(resolve);
        else if (ws.readyState !== WebSocket.CONNECTING)
          settle(() => reject(new Error('WebSocket is closed')));
      });
      if (!isCurrentAttempt() || currentWs !== ws) {
        return;
      }

      ws.onerror = (error) => {
        if (!isCurrentAttempt() || currentWs !== ws) {
          return;
        }
        updateStatus('WebSocket error: ' + error);
      };

      ws.onclose = () => {
        if (!isCurrentAttempt() || currentWs !== ws) {
          return;
        }
        updateStatus('WebSocket closed');
        // Signaling can close while WebRTC still plays. Its own failure handlers govern retries.
      };

      // Request RTCConfiguration. The reply doubles as the capability
      // handshake: camera-capable Android servers advertise
      // `cameraSupported: true` alongside the configuration.
      const rtcConfigPromise = new Promise<{
        rtcConfiguration: RTCConfiguration;
        cameraSupported: boolean;
        foldSupported: boolean;
      }>((resolve, reject) => {
        let settled = false;
        const cancel = () => settle(() => reject(new Error('Connection stopped')));
        pendingWaits.add(cancel);
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          pendingWaits.delete(cancel);
          window.clearTimeout(timeoutId);
          ws.removeEventListener('message', messageHandler);
          callback();
        };
        const timeoutId = window.setTimeout(
          () => settle(() => reject(new Error('RTCConfiguration timeout'))),
          30000,
        );

        const messageHandler = (event: MessageEvent) => {
          if (!isCurrentAttempt() || currentWs !== ws) {
            return;
          }
          try {
            const message = JSON.parse(event.data);
            if (
              message.type === 'signalingError' &&
              message.requestType === 'requestRtcConfiguration' &&
              message.sessionId === sessionId
            ) {
              const reason =
                typeof message.error === 'string' ? message.error : 'Unable to load streaming configuration';
              settle(() => reject(new Error(reason)));
            } else if (message.type === 'rtcConfiguration') {
              settle(() =>
                resolve({
                  rtcConfiguration: message.rtcConfiguration,
                  cameraSupported: message.cameraSupported === true,
                  foldSupported: message.foldSupported === true,
                }),
              );
            }
          } catch (e) {
            console.error('Error handling RTC configuration:', e);
            settle(() => reject(e));
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

      const {
        rtcConfiguration: rtcConfig,
        cameraSupported: serverCameraSupported,
        foldSupported,
      } = await rtcConfigPromise;
      if (!isCurrentAttempt() || currentWs !== ws) {
        return;
      }

      const isDuo = deviceModel === 'iphone-duo' || foldSupported;
      setDetectedDuo(isDuo);
      // Keep browser LAN and VPN addresses out of signaling and connectivity checks.
      const peerConnection = new RTCPeerConnection({ ...rtcConfig, iceTransportPolicy: 'relay' });
      currentPeerConnection = peerConnection;
      const playback = { peer: peerConnection, displays: new Map<RTCRtpReceiver, 'primary' | 'inner'>() };
      playbackConnection = playback;
      refreshPlaybackStats();
      peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      const videoTransceiver = peerConnection.addTransceiver('video', { direction: 'recvonly' });
      const duoTransceiver = isDuo ? peerConnection.addTransceiver('video', { direction: 'recvonly' }) : null;

      // iOS always supports camera/mic injection; Android servers
      // advertise it through `cameraSupported` (Android 15 and newer).
      // Never offer the extra sendonly m-lines to non-capable Android
      // servers — older servers cannot negotiate them safely.
      const canSendMedia = platform === 'ios' || serverCameraSupported;

      // Pre-allocate a sendonly slot for the user's camera so the
      // device can pull frames later without renegotiating SDP.
      // Allocating up-front means we don't have to renegotiate the
      // SDP when the device app actually opens its camera session —
      // the codec/SSRC negotiation happens once, here, and turning
      // the camera on/off later is just a `replaceTrack`.
      const outboundCameraTransceiver =
        canSendMedia ?
          peerConnection.addTransceiver('video', {
            direction: 'sendonly',
          })
        : null;
      currentOutboundCameraSender = outboundCameraTransceiver?.sender ?? null;

      // Same pre-allocation for the live microphone: a sendonly audio
      // slot negotiated once at connection setup, so toggling the mic
      // later is just `replaceTrack` — no SDP renegotiation.
      const outboundMicTransceiver =
        canSendMedia ?
          peerConnection.addTransceiver('audio', {
            direction: 'sendonly',
          })
        : null;
      currentOutboundMicSender = outboundMicTransceiver?.sender ?? null;

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
          duoTransceiver?.setCodecPreferences(sortedCodecs);
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
      if (outboundCameraTransceiver && RTCRtpSender.getCapabilities) {
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
      currentDataChannel = dataChannel;
      const latencyTrace =
        !isDuo && options.onTrace ?
          createLatencyTrace(peerConnection, (message) => {
            if (isCurrentAttempt() && currentPeerConnection === peerConnection) {
              safeInvoke('onTrace', options.onTrace, message);
            }
          })
        : null;
      currentLatencyTrace = latencyTrace;

      dataChannel.onopen = () => {
        if (!isCurrentAttempt() || currentDataChannel !== dataChannel || currentWs !== ws) {
          return;
        }
        currentControlChannelOpened = true;
        updateState({ controlReady: true });
        clearConnectionSuccessTimeout();
        updateStatus('Control channel opened');
        if (isDuo) ws.send(JSON.stringify({ type: 'getFoldState', id: 'duo-capabilities' }));

        // Spin up the AX fetcher now that we have a stable WS + control
        // channel. The fetcher's send function reuses this WS; it stops
        // sending if the WS dies. start() is called lazily based on the
        // inspectMode option or updateOptions().
        if (!currentAxFetcher) {
          currentAxFetcher = new AxFetcher({
            platform,
            baseIntervalMs: axPollIntervalMs,
            maxBackoffMs: axMaxBackoffMs,
            androidElementTreeOptions,
            send: (payload) => {
              if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return false;
              try {
                currentWs.send(JSON.stringify(payload));
                return true;
              } catch {
                return false;
              }
            },
            onSnapshot: publishAxSnapshot,
            onStatusChange: (status, error) => {
              safeInvoke('onAxStatusChange', options.onAxStatusChange, status, error);
            },
          });
          if (options.inspectMode === true || options.inspectMode === 'hover-only') {
            currentAxFetcher.start();
          }
        }
        const sendRequestFrame = () => {
          if (
            !isCurrentAttempt() ||
            currentFirstFrameShown ||
            currentDataChannel !== dataChannel ||
            currentWs !== ws ||
            ws.readyState !== WebSocket.OPEN
          ) {
            return;
          }
          ws.send(JSON.stringify({ type: 'requestFrame', sessionId: sessionId }));
        };

        sendRequestFrame();
        stopRequestFrameLoop();
        currentRequestFrameInterval = window.setInterval(() => {
          if (
            !isCurrentAttempt() ||
            currentFirstFrameShown ||
            currentDataChannel !== dataChannel ||
            currentWs !== ws ||
            ws.readyState !== WebSocket.OPEN
          ) {
            stopRequestFrameLoop();
            return;
          }
          sendRequestFrame();
        }, 250);

        // Open the requested URL once input is ready
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
          currentAxFetcher?.bumpActivity();
        }
      };

      dataChannel.onclose = () => {
        if (!isCurrentAttempt() || currentDataChannel !== dataChannel) {
          return;
        }
        updateStatus('Control channel closed');
      };

      dataChannel.onerror = (error) => {
        if (!isCurrentAttempt() || currentDataChannel !== dataChannel) {
          return;
        }
        console.error('Control channel error:', error);
        updateStatus('Control channel error: ' + error);
      };

      // Set up connection state monitoring
      peerConnection.onconnectionstatechange = () => {
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
          return;
        }
        updateStatus('Connection state: ' + peerConnection.connectionState);
        // Later TURN candidates can recover an initial failure.
        // Let the connection deadline handle startup until the control channel opens.
        if (peerConnection.connectionState === 'failed' && currentControlChannelOpened) {
          scheduleRetry('WebRTC connection entered failed state', generation);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
          return;
        }
        const iceState = peerConnection.iceConnectionState;
        updateStatus('ICE state: ' + iceState);
        if (iceState === 'connected' || iceState === 'completed') {
          clearIceDisconnectedGrace();
          // Re-attach the live microphone across reconnects (or apply a
          // option enabled before the connection was up).
          if (isMicrophoneWanted() && !currentOutboundMicStream) {
            void attachMicrophone();
          }
          return;
        }
        if (iceState === 'failed') {
          clearIceDisconnectedGrace();
          if (currentControlChannelOpened) {
            scheduleRetry('ICE connection entered failed state', generation);
          }
          return;
        }
        if (
          iceState === 'disconnected' &&
          currentControlChannelOpened &&
          options.autoReconnect &&
          currentIceDisconnectedGrace === undefined
        ) {
          // Cap the browser's natural disconnected→failed escalation to recover faster.
          currentIceDisconnectedGrace = window.setTimeout(() => {
            currentIceDisconnectedGrace = undefined;
            if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
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
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
          return;
        }
        // Audio and video share the preference because synchronization can
        // otherwise keep video at the audio receiver's higher target.
        applyJitterBufferTarget(event.receiver, options.jitterBufferTargetMs);
        const inner =
          event.track.id === 'duo-inner' || event.streams.some((stream) => stream.id === 'duo-inner');
        if (event.track.kind === 'video') playback.displays.set(event.receiver, inner ? 'inner' : 'primary');
        updateStatus('Received remote track: ' + event.track.kind);
        if (event.track.kind === 'video') {
          const display = inner ? 'inner' : 'primary';
          const stream =
            isDuo ? new MediaStream([event.track]) : event.streams[0] ?? new MediaStream([event.track]);
          streams.set(display, stream);
          for (const [element, entry] of videos) {
            if (entry.display === display) playVideo(element, entry, stream);
          }
        }
      };

      // Handle ICE candidates
      peerConnection.onicecandidate = (event) => {
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection || currentWs !== ws) {
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
        if (!isCurrentAttempt() || currentWs !== ws) {
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
        if (currentAxFetcher?.handleMessage(message)) {
          return;
        }
        updateStatus('Received: ' + message.type);
        switch (message.type) {
          case 'performActionsResult':
          case 'foldStateResult':
          case 'foldStateChanged': {
            if (!isDuo) break;
            if (message.state) {
              setDuoState(message.state);
              setDuoError(undefined);
            } else if (message.id === 'duo-capabilities')
              setDuoError(message.error || 'This instance does not support native iPhone Duo displays.');
            const request = currentDuoRequests.get(message.id);
            if (request) {
              clearTimeout(request.timer);
              currentDuoRequests.delete(message.id);
              if (message.error) request.reject(new Error(message.error));
              else request.resolve();
            }
            break;
          }
          case 'signalingError': {
            if (message.requestType !== 'offer' || message.sessionId !== sessionId) {
              break;
            }
            const reason =
              typeof message.error === 'string' ?
                message.error
              : 'Unable to establish the streaming connection';
            updateStatus('Error: ' + reason);
            scheduleRetry(reason, generation);
            break;
          }
          case 'answer':
            if (!currentPeerConnection || currentPeerConnection !== peerConnection) {
              updateStatus('No peer connection, skipping answer');
              break;
            }
            latencyTrace?.accept(message.latencyTraceVersion);
            await peerConnection.setRemoteDescription(
              new RTCSessionDescription({
                type: 'answer',
                sdp: message.sdp,
              }),
            );
            if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
              return;
            }
            updateStatus('Set remote description');
            break;
          case 'candidate':
            if (!currentPeerConnection || currentPeerConnection !== peerConnection) {
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
            if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
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
              const rejecter = currentPendingScreenshotRejecters.get(message.id);
              if (!rejecter) {
                debugWarn(`Received screenshot error for unknown or handled id: ${message.id}`);
                break;
              }
              debugWarn(`Received screenshot error for id ${message.id}: ${screenshotError}`);
              rejecter(new Error(screenshotError));
              currentPendingScreenshotResolvers.delete(message.id);
              currentPendingScreenshotRejecters.delete(message.id);
              clearTimeout(requestTimers.get(message.id));
              requestTimers.delete(message.id);
              break;
            }
            const screenshotData = toScreenshotData(message);
            if (!screenshotData) {
              debugWarn('Received screenshot message without image data:', message);
              break;
            }
            const resolver = currentPendingScreenshotResolvers.get(message.id);
            if (!resolver) {
              debugWarn(`Received screenshot data for unknown or handled id: ${message.id}`);
              break;
            }
            debugLog(`Received screenshot data for id ${message.id}`);
            resolver(screenshotData);
            currentPendingScreenshotResolvers.delete(message.id);
            currentPendingScreenshotRejecters.delete(message.id);
            clearTimeout(requestTimers.get(message.id));
            requestTimers.delete(message.id);
            break;
          }
          case 'screenshotError':
            if (typeof message.id !== 'string' || typeof message.message !== 'string') {
              debugWarn('Received invalid screenshot error message:', message);
              break;
            }
            const rejecter = currentPendingScreenshotRejecters.get(message.id);
            if (!rejecter) {
              debugWarn(`Received screenshot error for unknown or handled id: ${message.id}`);
              break;
            }
            debugWarn(`Received screenshot error for id ${message.id}: ${message.message}`);
            rejecter(new Error(message.message));
            currentPendingScreenshotResolvers.delete(message.id);
            currentPendingScreenshotRejecters.delete(message.id);
            clearTimeout(requestTimers.get(message.id));
            requestTimers.delete(message.id);
            break;
          case 'cameraRequest': {
            // Only camera-capable sessions allocate the sendonly
            // outbound-camera transceiver; without it there is nothing to
            // feed the device, so ignore camera requests entirely — no
            // getUserMedia prompt and no onCameraDemandChange callbacks.
            const sender = currentOutboundCameraSender;
            if (!sender) {
              break;
            }
            const request = parseCameraRequest(message);
            if (!request) {
              debugWarn('Received invalid cameraRequest:', message);
              break;
            }
            console.info('[RemoteControl] cameraRequest received:', request.active, request.facingMode);
            await handleCameraRequest(request, ws, sender, isCurrentAttempt);
            break;
          }
          case 'microphoneRequest': {
            if (!currentOutboundMicSender) {
              break;
            }
            const active = message.active === true;
            currentMicrophoneDemandActive = active;
            console.info('[RemoteControl] microphoneRequest received, active=', active);
            if (!active) {
              if (!currentMicrophoneEnabled) {
                await detachMicrophone();
              }
              break;
            }
            if (currentOutboundMicStream) {
              // A manual stream may already be attached. Re-select it on the
              // host because file playback can have replaced its source.
              sendMicrophoneStart(ws);
              break;
            }
            await attachMicrophone();
            break;
          }
          case 'microphoneStartResult': {
            if (currentMicStartPendingId === null || message.id !== currentMicStartPendingId) {
              break;
            }
            currentMicStartPendingId = null;
            if (typeof message.error === 'string') {
              // Host rejected the stream (e.g. no loopback device
              // assigned on the node). Tear the capture back down so
              // the browser's mic indicator doesn't stay lit for a
              // stream nobody hears.
              console.warn('[RemoteControl] microphoneStart rejected by host:', message.error);
              void detachMicrophone(message.error);
            }
            break;
          }
          case 'terminateAppResult':
            if (typeof message.id !== 'string') {
              debugWarn('Received invalid terminateApp result message:', message);
              break;
            }
            if (typeof message.error === 'string') {
              const terminateRejecter = currentPendingTerminateAppRejecters.get(message.id);
              if (!terminateRejecter) {
                debugWarn(`Received terminateApp error for unknown or handled id: ${message.id}`);
                break;
              }
              debugWarn(`Received terminateApp error for id ${message.id}: ${message.error}`);
              terminateRejecter(new Error(message.error));
              currentPendingTerminateAppResolvers.delete(message.id);
              currentPendingTerminateAppRejecters.delete(message.id);
              clearTimeout(requestTimers.get(message.id));
              requestTimers.delete(message.id);
              break;
            }
            const terminateResolver = currentPendingTerminateAppResolvers.get(message.id);
            if (!terminateResolver) {
              debugWarn(`Received terminateApp result for unknown or handled id: ${message.id}`);
              break;
            }
            debugLog(`Received terminateApp success for id ${message.id}`);
            terminateResolver();
            currentPendingTerminateAppResolvers.delete(message.id);
            currentPendingTerminateAppRejecters.delete(message.id);
            clearTimeout(requestTimers.get(message.id));
            requestTimers.delete(message.id);
            break;
          default:
            debugWarn(`Received unhandled message type: ${message.type}`, message);
            break;
        }
      };

      // Create and send offer
      if (currentPeerConnection === peerConnection) {
        const offer = await peerConnection.createOffer({
          offerToReceiveVideo: true,
          offerToReceiveAudio: false,
        });
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
          return;
        }
        await peerConnection.setLocalDescription(offer);
        if (!isCurrentAttempt() || currentPeerConnection !== peerConnection) {
          return;
        }

        if (isCurrentAttempt() && currentWs === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'offer',
              ...(isDuo ? { displayStreams: true } : {}),
              ...(latencyTrace ? { latencyTraceVersion: 1 } : {}),
              sdp: offer.sdp,
              sessionId: sessionId,
            }),
          );
        }
        updateStatus('Sent offer');
      }
    } catch (e) {
      if (!isCurrentAttempt() || (e instanceof Error && e.message === 'Connection stopped')) {
        return;
      }
      const reason = e instanceof Error ? e.message : String(e);
      updateStatus('Error: ' + reason);
      scheduleRetry(reason, generation);
    }
  };

  const start = () => {
    if (disposed) throw new Error('Device stream is disposed');
    lifecycleGeneration++;
    currentTerminationProbeInFlight = false;
    publishAxSnapshot(null);
    currentConnectionState = null;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) startKeepAlive();
    // An explicit start or reconnect
    // clears any prior terminated verdict so we re-evaluate from scratch.
    currentTerminated = false;

    void startAttempt(0);
  };

  const stop = () => {
    lifecycleGeneration++;
    currentTerminationProbeInFlight = false;
    stopKeepAlive();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    currentConnectionGeneration += 1;
    currentConnectionAttempt = 0;
    currentControlChannelOpened = false;
    clearScheduledRetry();
    clearIceDisconnectedGrace();
    teardownConnection();
    currentConnectionState = null;
    updateState({ connection: 'idle', videoReady: false, controlReady: false });
    updateStatus('Stopped');
  };

  const attachVideo = (video: HTMLVideoElement, display: StreamDisplay = 'primary') => {
    if (disposed) throw new Error('Device stream is disposed');
    if (videos.has(video)) throw new Error('Video element is already attached');
    const entry: VideoEntry = { display };
    videos.set(video, entry);
    const loaded = () => {
      if (display === 'primary' && streams.has(display)) markFirstFrameShown();
    };
    video.addEventListener('loadeddata', loaded);
    const stream = streams.get(display);
    if (stream) playVideo(video, entry, stream);
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      attachments.delete(detach);
      video.removeEventListener('loadeddata', loaded);
      entry.stop?.();
      videos.delete(video);
      video.srcObject = null;
    };
    attachments.add(detach);
    return detach;
  };
  const attachFrameSink = (sink: DeviceFrameSink, display: StreamDisplay = 'primary') => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    const detach = attachVideo(video, display);
    let detached = false;
    let frame = 0;
    let animation = 0;
    const cancel = () => {
      video.cancelVideoFrameCallback?.(frame);
      cancelAnimationFrame(animation);
    };
    const draw = () => {
      if (detached || !video.srcObject) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        safeInvoke(
          'present',
          (...args) => sink.present(...args),
          video,
          video.videoWidth,
          video.videoHeight,
          display,
        );
      }
      if (detached || !video.srcObject) return;
      if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(draw);
      else animation = requestAnimationFrame(draw);
    };
    const loaded = () => {
      cancel();
      draw();
    };
    videos.get(video)!.clear = cancel;
    video.addEventListener('loadeddata', loaded);
    const release = () => {
      if (detached) return;
      detached = true;
      attachments.delete(release);
      cancel();
      video.removeEventListener('loadeddata', loaded);
      detach();
      video.remove();
    };
    attachments.delete(detach);
    attachments.add(release);
    if (video.readyState >= 2) loaded();
    return release;
  };
  return {
    start,
    stop,
    attachVideo,
    attachFrameSink,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stop();
      for (const detach of attachments) detach();
      attachments.clear();
    },
    getState: () => state,
    updateOptions: (patch: Partial<DeviceStreamLiveOptions>) => {
      if (disposed) throw new Error('Device stream is disposed');
      const previous = options;
      options = { ...options, ...patch };
      if (previous.jitterBufferTargetMs !== options.jitterBufferTargetMs) {
        for (const transceiver of currentPeerConnection?.getTransceivers() ?? []) {
          if (transceiver.currentDirection === 'recvonly' || transceiver.currentDirection === 'sendrecv')
            applyJitterBufferTarget(transceiver.receiver, options.jitterBufferTargetMs);
        }
      }
      if (!!previous.onPlaybackStats !== !!options.onPlaybackStats) refreshPlaybackStats();
      if (!!previous.microphoneEnabled !== !!options.microphoneEnabled) {
        currentMicrophoneEnabled = options.microphoneEnabled ?? false;
        if (isMicrophoneWanted()) void attachMicrophone();
        else void detachMicrophone();
      }
      if (!!previous.inspectMode !== !!options.inspectMode) {
        if (options.inspectMode) currentAxFetcher?.start();
        else {
          currentAxFetcher?.stop();
          if (currentAxSnapshot !== null) publishAxSnapshot(null);
        }
      }
    },
    sendControl: sendBinaryControlMessage,
    sendTouch: (
      phase: 'begin' | 'move' | 'end',
      x: number,
      y: number,
      width: number,
      height: number,
      pointerId = 0,
    ) =>
      sendBinaryControlMessage(
        createTouchControlMessage(
          phase === 'begin' ? 0
          : phase === 'end' ? 1
          : 2,
          pointerId,
          width,
          height,
          x,
          y,
          phase === 'end' ? 0 : 1,
        ),
      ),
    sendText: (text: string) => sendBinaryControlMessage(createSetClipboardMessage(text)),
    sendDisplayTouch: (action: number, display: number, x: number, y: number) =>
      sendBinaryControlMessage(createDisplayTouchMessage(action, display, x, y)),
    sendDuoControl,
    pressButton: (button: 'home' | 'back' | 'recents' | 'power') => {
      const code = { home: 3, back: 4, recents: 187, power: 26 }[button];
      sendBinaryControlMessage(createInjectKeycodeMessage(0, code, 0, 0));
      sendBinaryControlMessage(createInjectKeycodeMessage(1, code, 0, 0));
    },
    rotate: () => sendBinaryControlMessage(new Uint8Array([11]).buffer),
    bumpActivity: () => currentAxFetcher?.bumpActivity(),
    getAxStatus: () => currentAxFetcher?.getStatus() ?? 'idle',
    openUrl: (newUrl: string) => {
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        debugWarn('WebSocket not open, cannot send open_url command.');
        return;
      }
      try {
        const decodedUrl = decodeURIComponent(newUrl);
        updateStatus('Opening URL');
        currentWs.send(
          JSON.stringify({
            type: 'openUrl',
            url: decodedUrl,
            sessionId: sessionId,
          }),
        );
      } catch (error) {
        debugWarn('Error decoding or sending URL :', { error, url: newUrl });
        currentWs.send(
          JSON.stringify({
            type: 'openUrl',
            url: newUrl,
            sessionId: sessionId,
          }),
        );
      }
      currentAxFetcher?.bumpActivity();
    },

    sendKeyEvent: (event: ImperativeKeyboardEvent) => {
      if (!currentDataChannel || currentDataChannel.readyState !== 'open') {
        debugWarn('Data channel not ready for imperative key command:', currentDataChannel?.readyState);
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
    screenshot: (display?: 'outer' | 'inner'): Promise<ScreenshotData> => {
      return new Promise<ScreenshotData>((resolve, reject) => {
        if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
          debugWarn('WebSocket not open, cannot send screenshot command.');
          return reject(new Error('WebSocket is not connected or connection is not open.'));
        }

        const id = `ui-ss-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const request = {
          type: display ? 'screenshotDisplay' : 'screenshot',
          ...(display ? { display } : {}),
          id: id,
        };

        currentPendingScreenshotResolvers.set(id, resolve);
        currentPendingScreenshotRejecters.set(id, reject);

        debugLog('Sending screenshot request:', request);
        try {
          currentWs.send(JSON.stringify(request));
        } catch (err) {
          debugWarn('Failed to send screenshot request immediately:', err);
          currentPendingScreenshotResolvers.delete(id);
          currentPendingScreenshotRejecters.delete(id);
          reject(err);
          return; // Important to return here if send failed synchronously
        }

        requestTimers.set(
          id,
          setTimeout(() => {
            requestTimers.delete(id);
            if (currentPendingScreenshotResolvers.has(id)) {
              debugWarn(`Screenshot request timed out for id ${id}`);
              currentPendingScreenshotRejecters.get(id)?.(new Error('Screenshot request timed out'));
              currentPendingScreenshotResolvers.delete(id);
              currentPendingScreenshotRejecters.delete(id);
            }
          }, 30000),
        );
      });
    },
    terminateApp: (bundleId: string): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
          debugWarn('WebSocket not open, cannot send terminateApp command.');
          return reject(new Error('WebSocket is not connected or connection is not open.'));
        }
        const id = `ui-term-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const request = {
          type: 'terminateApp',
          id,
          bundleId,
        };

        currentPendingTerminateAppResolvers.set(id, resolve);
        currentPendingTerminateAppRejecters.set(id, reject);

        debugLog('Sending terminateApp request:', request);
        try {
          currentWs.send(JSON.stringify(request));
        } catch (err) {
          debugWarn('Failed to send terminateApp request immediately:', err);
          currentPendingTerminateAppResolvers.delete(id);
          currentPendingTerminateAppRejecters.delete(id);
          reject(err);
          return;
        }
        // Terminating the foreground app drops the user back to the home
        // screen — bump so the overlay reflects the post-terminate state
        // through the SpringBoard transition.
        currentAxFetcher?.bumpActivity();

        requestTimers.set(
          id,
          setTimeout(() => {
            requestTimers.delete(id);
            if (currentPendingTerminateAppResolvers.has(id)) {
              debugWarn(`terminateApp request timed out for id ${id}`);
              currentPendingTerminateAppRejecters.get(id)?.(new Error('terminateApp request timed out'));
              currentPendingTerminateAppResolvers.delete(id);
              currentPendingTerminateAppRejecters.delete(id);
            }
          }, 30000),
        );
      });
    },
    reconnect: () => start(),

    refreshAxTree: async (): Promise<AxSnapshot> => {
      const fetcher = currentAxFetcher;
      if (!fetcher) {
        throw new Error('Inspect mode is not active');
      }
      // refresh() also delivers the snapshot through onAxSnapshotChange.
      return fetcher.refresh();
    },

    getAxSnapshot: () => currentAxSnapshot,
  };
}
export type DeviceStream = ReturnType<typeof createDeviceStream>;

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
