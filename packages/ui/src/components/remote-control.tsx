import React, { useEffect, useRef, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { clsx } from 'clsx';
import './remote-control.css';

import { ANDROID_KEYS, AMOTION_EVENT, codeMap } from '../core/constants';

import iphoneFrameImage from '../assets/iphone16pro_black_bg.webp';
import pixelFrameImage from '../assets/pixel9_black.webp';
import pixelFrameImageLandscape from '../assets/pixel9_black_landscape.webp';
import iphoneFrameImageLandscape from '../assets/iphone16pro_black_landscape_bg.webp';
import appleLogoSvg from '../assets/Apple_logo_white.svg';
import androidBootImage from '../assets/android_boot.webp';
import {
  createTouchControlMessage,
  createInjectKeycodeMessage,
  createSetClipboardMessage,
  createTwoFingerTouchControlMessage,
} from '../core/webrtc-messages';

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
    portrait: { heightMultiplier?: number; widthMultiplier?: number; };
    landscape: { heightMultiplier?: number; widthMultiplier?: number; };
  };
  frame: {
    image: string;
    imageLandscape: string;
  }
}

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
  ({ className, url, token, sessionId: propSessionId, openUrl, showFrame = true }: RemoteControlProps, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const frameRef = useRef<HTMLImageElement>(null);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [isLandscape, setIsLandscape] = useState(false);
    const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({});
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const keepAliveIntervalRef = useRef<number | undefined>(undefined);
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
      inside: boolean;
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
      const { inside: isInside, videoX, videoY, videoWidth, videoHeight } = geometry;

      let action: number | null = null;
      let positionToSend: { x: number; y: number } | null = null;
      let pressure = 1.0; // Default pressure
      const buttons = AMOTION_EVENT.BUTTON_PRIMARY; // Assume primary button

      switch (eventType) {
        case 'down':
          if (isInside) {
            // For multi-touch: use ACTION_DOWN for first pointer, ACTION_POINTER_DOWN for additional pointers
            const currentPointerCount = activePointers.current.size;
            action =
              currentPointerCount === 0
                ? AMOTION_EVENT.ACTION_DOWN
                : AMOTION_EVENT.ACTION_POINTER_DOWN;
            positionToSend = { x: videoX, y: videoY };
            activePointers.current.set(pointerId, positionToSend);
            if (pointerId === -1) {
              // Focus on mouse down
              videoRef.current?.focus();
            }
          } else {
            // If the initial down event is outside, ignore it for this pointer
            activePointers.current.delete(pointerId);
          }
          break;

        case 'move':
          if (activePointers.current.has(pointerId)) {
            if (isInside) {
              action = AMOTION_EVENT.ACTION_MOVE;
              positionToSend = { x: videoX, y: videoY };
              // Update the last known position for this active pointer
              activePointers.current.set(pointerId, positionToSend);
            } else {
              // Moved outside while active - do nothing, UP/CANCEL will use last known pos
            }
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
                remainingPointerCount === 0
                  ? AMOTION_EVENT.ACTION_UP
                  : AMOTION_EVENT.ACTION_POINTER_UP;
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
            isInside,
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
        // Clean up map just in case if 'down' was outside and 'up'/'cancel' is triggered
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
        const message = createInjectKeycodeMessage(action, ANDROID_KEYS.KEYCODE_ALT_LEFT, 0, ANDROID_KEYS.META_NONE);
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

    // Map a client point to video coordinates using a pre-computed context.
    // Returns null if outside the video content area or context is missing.
    const mapClientPointToVideo = (
      ctx: VideoMappingContext,
      clientX: number,
      clientY: number,
    ): PointerGeometry | null => {
      const relativeX = clientX - ctx.videoRect.left - ctx.offsetX;
      const relativeY = clientY - ctx.videoRect.top - ctx.offsetY;

      const isInside =
        relativeX >= 0 && relativeX <= ctx.actualWidth &&
        relativeY >= 0 && relativeY <= ctx.actualHeight;

      if (!isInside) {
        return {
          inside: false,
          videoX: 0,
          videoY: 0,
          videoWidth: ctx.videoWidth,
          videoHeight: ctx.videoHeight,
        };
      }

      const videoX = Math.max(0, Math.min(ctx.videoWidth, (relativeX / ctx.actualWidth) * ctx.videoWidth));
      const videoY = Math.max(0, Math.min(ctx.videoHeight, (relativeY / ctx.actualHeight) * ctx.videoHeight));

      return {
        inside: true,
        videoX,
        videoY,
        videoWidth: ctx.videoWidth,
        videoHeight: ctx.videoHeight,
      };
    };

    // Compute full hover point with mirror/container coordinates (for Alt indicator rendering).
    const computeFullHoverPoint = (
      ctx: VideoMappingContext,
      clientX: number,
      clientY: number,
    ): HoverPoint | null => {
      const relativeX = clientX - ctx.videoRect.left - ctx.offsetX;
      const relativeY = clientY - ctx.videoRect.top - ctx.offsetY;

      const isInside =
        relativeX >= 0 && relativeX <= ctx.actualWidth &&
        relativeY >= 0 && relativeY <= ctx.actualHeight;

      if (!isInside) {
        return null;
      }

      const videoX = Math.max(0, Math.min(ctx.videoWidth, (relativeX / ctx.actualWidth) * ctx.videoWidth));
      const videoY = Math.max(0, Math.min(ctx.videoHeight, (relativeY / ctx.actualHeight) * ctx.videoHeight));
      const mirrorVideoX = ctx.videoWidth - videoX;
      const mirrorVideoY = ctx.videoHeight - videoY;

      const contentLeft = ctx.videoRect.left + ctx.offsetX;
      const contentTop = ctx.videoRect.top + ctx.offsetY;
      const containerX = contentLeft - ctx.containerRect.left + relativeX;
      const containerY = contentTop - ctx.containerRect.top + relativeY;
      const mirrorContainerX = contentLeft - ctx.containerRect.left + (ctx.actualWidth - relativeX);
      const mirrorContainerY = contentTop - ctx.containerRect.top + (ctx.actualHeight - relativeY);

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
      const msg = createTwoFingerTouchControlMessage(
        action,
        videoWidth,
        videoHeight,
        x0,
        y0,
        x1,
        y1,
      );
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
        const action = eventType === 'down' ? AMOTION_EVENT.ACTION_DOWN
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

    // Unified handler for both mouse and touch interactions
    const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();

      // Compute mapping context once per event (reused for all pointers)
      const ctx = computeVideoMappingContext();

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

      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open' || !videoRef.current || !ctx) {
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
            if (g0.inside && g1.inside) {
              twoFingerStateRef.current = {
                finger0: { x: g0.videoX, y: g0.videoY },
                finger1: { x: g1.videoX, y: g1.videoY },
                videoSize: { width: g0.videoWidth, height: g0.videoHeight },
                source: 'real-touch',
                pointerId0: t0.identifier,
                pointerId1: t1.identifier,
              };
              applyTwoFingerEvent('down', g0.videoWidth, g0.videoHeight,
                                  g0.videoX, g0.videoY, g1.videoX, g1.videoY,
                                  t0.identifier, t1.identifier);
            }
          } else if (twoFingerStateRef.current.source === 'real-touch') {
            // Continuing two-finger gesture (move)
            if (g0.inside && g1.inside) {
              twoFingerStateRef.current.finger0 = { x: g0.videoX, y: g0.videoY };
              twoFingerStateRef.current.finger1 = { x: g1.videoX, y: g1.videoY };
              applyTwoFingerEvent('move', g0.videoWidth, g0.videoHeight,
                                  g0.videoX, g0.videoY, g1.videoX, g1.videoY,
                                  twoFingerStateRef.current.pointerId0,
                                  twoFingerStateRef.current.pointerId1);
            }
          }
        } else if (allTouches.length < 2 && twoFingerStateRef.current?.source === 'real-touch') {
          // Finger lifted - end two-finger gesture using last known state
          const state = twoFingerStateRef.current;
          applyTwoFingerEvent('up', state.videoSize.width, state.videoSize.height,
                              state.finger0.x, state.finger0.y,
                              state.finger1.x, state.finger1.y,
                              state.pointerId0, state.pointerId1);
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
              inside: geometry.inside,
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
      const { inside, videoX, videoY, videoWidth, videoHeight } = geometry;
      const mirrorX = videoWidth - videoX;
      const mirrorY = videoHeight - videoY;

      if (eventType === 'down') {
        if (inside) {
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
          applyTwoFingerEvent('down', videoWidth, videoHeight, videoX, videoY, mirrorX, mirrorY,
                              ALT_POINTER_ID_PRIMARY, ALT_POINTER_ID_MIRROR);
        }
        return;
      }

      if (eventType === 'move') {
        if (twoFingerStateRef.current?.source === 'alt-mouse' && inside) {
          // Update positions
          twoFingerStateRef.current.finger0 = { x: videoX, y: videoY };
          twoFingerStateRef.current.finger1 = { x: mirrorX, y: mirrorY };
          applyTwoFingerEvent('move', videoWidth, videoHeight, videoX, videoY, mirrorX, mirrorY,
                              ALT_POINTER_ID_PRIMARY, ALT_POINTER_ID_MIRROR);
        }
        // If outside, we just don't send a move - UP will use last known position
        return;
      }

      if (eventType === 'up' || eventType === 'cancel') {
        const state = twoFingerStateRef.current;
        if (state?.source === 'alt-mouse') {
          // End gesture at last known inside positions
          const { finger0, finger1, videoSize } = state;
          applyTwoFingerEvent('up', videoSize.width, videoSize.height,
                              finger0.x, finger0.y, finger1.x, finger1.y,
                              ALT_POINTER_ID_PRIMARY, ALT_POINTER_ID_MIRROR);
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

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopKeepAlive();
      } else {
        startKeepAlive();
      }
    };

    const start = async () => {
      try {
        wsRef.current = new WebSocket(`${url}?token=${token}`);

        wsRef.current.onerror = (error) => {
          updateStatus('WebSocket error: ' + error);
        };

        wsRef.current.onclose = () => {
          updateStatus('WebSocket closed');
        };

        // Wait for WebSocket to connect
        await new Promise((resolve, reject) => {
          if (wsRef.current) {
            wsRef.current.onopen = resolve;
            setTimeout(() => reject(new Error('WebSocket connection timeout')), 30000);
          }
        });

        // Request RTCConfiguration
        const rtcConfigPromise = new Promise<RTCConfiguration>((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('RTCConfiguration timeout')), 30000);

          const messageHandler = (event: MessageEvent) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'rtcConfiguration') {
                clearTimeout(timeoutId);
                wsRef.current?.removeEventListener('message', messageHandler);
                resolve(message.rtcConfiguration);
              }
            } catch (e) {
              console.error('Error handling RTC configuration:', e);
              reject(e);
            }
          };

          wsRef.current?.addEventListener('message', messageHandler);
          wsRef.current?.send(
            JSON.stringify({
              type: 'requestRtcConfiguration',
              sessionId: sessionId,
            }),
          );
        });

        const rtcConfig = await rtcConfigPromise;
        peerConnectionRef.current = new RTCPeerConnection(rtcConfig);
        peerConnectionRef.current.addTransceiver('audio', { direction: 'recvonly' });
        const videoTransceiver = peerConnectionRef.current.addTransceiver('video', { direction: 'recvonly' });

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
            debugLog('Set codec preferences:', sortedCodecs.map(c => c.mimeType).join(', '));
          }
        }

        dataChannelRef.current = peerConnectionRef.current.createDataChannel('control', {
          ordered: true,
          negotiated: true,
          id: 1,
        });

        dataChannelRef.current.onopen = () => {
          updateStatus('Control channel opened');
          // Request first frame once we're ready to receive video
          if (wsRef.current) {
            for (let i = 0; i < 12; i++) {
              setTimeout(() => {
                if (wsRef.current) {
                  wsRef.current.send(JSON.stringify({ type: 'requestFrame', sessionId: sessionId }));
                }
              }, i * 125); // 125ms = quarter second
            }

            // Send openUrl message if the prop is provided
            if (openUrl) {
              try {
                const decodedUrl = decodeURIComponent(openUrl);
                updateStatus('Opening URL');
                wsRef.current.send(
                  JSON.stringify({
                    type: 'openUrl',
                    url: decodedUrl,
                    sessionId: sessionId,
                  }),
                );
              } catch (error) {
                console.error({ error }, 'Error decoding URL, falling back to the original URL');
                wsRef.current.send(
                  JSON.stringify({
                    type: 'openUrl',
                    url: openUrl,
                    sessionId: sessionId,
                  }),
                );
              }
            }
          }
        };

        dataChannelRef.current.onclose = () => {
          updateStatus('Control channel closed');
        };

        dataChannelRef.current.onerror = (error) => {
          console.error('Control channel error:', error);
          updateStatus('Control channel error: ' + error);
        };

        // Set up connection state monitoring
        peerConnectionRef.current.onconnectionstatechange = () => {
          updateStatus('Connection state: ' + peerConnectionRef.current?.connectionState);
        };

        peerConnectionRef.current.oniceconnectionstatechange = () => {
          updateStatus('ICE state: ' + peerConnectionRef.current?.iceConnectionState);
        };

        // Set up video handling
        peerConnectionRef.current.ontrack = (event) => {
          updateStatus('Received remote track: ' + event.track.kind);
          if (event.track.kind === 'video' && videoRef.current) {
            debugLog(`[${new Date().toISOString()}] Video track received:`, event.track);
            videoRef.current.srcObject = event.streams[0];
          }
        };

        // Handle ICE candidates
        peerConnectionRef.current.onicecandidate = (event) => {
          if (event.candidate && wsRef.current) {
            const message = {
              type: 'candidate',
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              sessionId: sessionId,
            };
            wsRef.current.send(JSON.stringify(message));
            updateStatus('Sent ICE candidate');
          } else {
            updateStatus('ICE candidate gathering completed');
          }
        };

        // Handle incoming messages
        wsRef.current.onmessage = async (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (e) {
            debugWarn('Error parsing message:', e);
            return;
          }
          updateStatus('Received: ' + message.type);
          switch (message.type) {
            case 'answer':
              if (!peerConnectionRef.current) {
                updateStatus('No peer connection, skipping answer');
                break;
              }
              await peerConnectionRef.current.setRemoteDescription(
                new RTCSessionDescription({
                  type: 'answer',
                  sdp: message.sdp,
                }),
              );
              updateStatus('Set remote description');
              break;
            case 'candidate':
              if (!peerConnectionRef.current) {
                updateStatus('No peer connection, skipping candidate');
                break;
              }
              await peerConnectionRef.current.addIceCandidate(
                new RTCIceCandidate({
                  candidate: message.candidate,
                  sdpMid: message.sdpMid,
                  sdpMLineIndex: message.sdpMLineIndex,
                }),
              );
              updateStatus('Added ICE candidate');
              break;
            case 'screenshot':
              if (typeof message.id !== 'string' || typeof message.dataUri !== 'string') {
                debugWarn('Received invalid screenshot success message:', message);
                break;
              }
              const resolver = pendingScreenshotResolversRef.current.get(message.id);
              if (!resolver) {
                debugWarn(`Received screenshot data for unknown or handled id: ${message.id}`);
                break;
              }
              debugLog(`Received screenshot data for id ${message.id}`);
              resolver({ dataUri: message.dataUri });
              pendingScreenshotResolversRef.current.delete(message.id);
              pendingScreenshotRejectersRef.current.delete(message.id);
              break;
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
        if (peerConnectionRef.current) {
          const offer = await peerConnectionRef.current.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false,
          });
          await peerConnectionRef.current.setLocalDescription(offer);

          if (wsRef.current) {
            wsRef.current.send(
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
        updateStatus('Error: ' + e);
      }
    };

    const stop = () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (dataChannelRef.current) {
        dataChannelRef.current.close();
        dataChannelRef.current = null;
      }
      updateStatus('Stopped');
    };

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
    }, [url, token, propSessionId]);

    // Calculate video position and border-radius based on frame dimensions
    useEffect(() => {
      const video = videoRef.current;
      const frame = frameRef.current;
      
      if (!video) return;
      
      // If no frame, no positioning needed
      if (!showFrame || !frame) {
        setVideoStyle({});
        return;
      }

      const updateVideoPosition = () => {
        const frameWidth = frame.clientWidth;
        const frameHeight = frame.clientHeight;
        
        if (frameWidth === 0 || frameHeight === 0) return;
        
        // Determine landscape based on video's intrinsic dimensions
        const landscape = video.videoWidth > video.videoHeight;
        setIsLandscape(landscape);
        
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
        newStyle.borderRadius = `${landscape ? frameHeight * config.videoBorderRadiusMultiplier : frameWidth * config.videoBorderRadiusMultiplier}px`;
        setVideoStyle(newStyle);
      };

      const resizeObserver = new ResizeObserver(() => {
        updateVideoPosition();
      });

      resizeObserver.observe(frame);
      resizeObserver.observe(video);
      
      // Also update when the frame image loads
      frame.addEventListener('load', updateVideoPosition);
      
      // Update when video metadata loads (to get correct intrinsic dimensions)
      video.addEventListener('loadedmetadata', updateVideoPosition);

      // IMPORTANT: When the WebRTC stream changes orientation, the intrinsic video size
      // (videoWidth/videoHeight) can change without re-firing 'loadedmetadata'.
      // The <video> element emits 'resize' in that case.
      video.addEventListener('resize', updateVideoPosition);

      // Initial calculation
      updateVideoPosition();

      return () => {
        resizeObserver.disconnect();
        video.removeEventListener('loadedmetadata', updateVideoPosition);
        video.removeEventListener('resize', updateVideoPosition);
        frame.removeEventListener('load', updateVideoPosition);
      };
    }, [config, showFrame]);

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
    }));

    // Show indicators when Alt is held and we have a valid hover point (null when outside)
    const showAltIndicators = isAltHeld && hoverPoint !== null;

    return (
      <div
        ref={containerRef}
        className={clsx(
          'rc-container',
          className,
        )}
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
            src={isLandscape ? config.frame.imageLandscape : config.frame.image}
            alt=""
            className={platform === 'ios' ? clsx('rc-phone-frame', 'rc-phone-frame-ios') : 'rc-phone-frame'}
            draggable={false}
          />
        )}
        <video
          ref={videoRef}
          className={clsx(
            'rc-video',
            !showFrame && 'rc-video-frameless',
            !videoLoaded && 'rc-video-loading',
          )}
          style={{
            ...videoStyle,
            ...(config.loadingLogo
              ? {
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
          onLoadedMetadata={() => setVideoLoaded(true)}
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
      </div>
    );
  },
);
