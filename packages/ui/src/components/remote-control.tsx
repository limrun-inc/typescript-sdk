import React, { useEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle } from 'react';
import { clsx } from 'clsx';
import './remote-control.css';

import { ANDROID_KEYS, AMOTION_EVENT, codeMap } from '../core/constants';
import {
  createTouchControlMessage,
  createInjectKeycodeMessage,
  createSetClipboardMessage,
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
  ({ className, url, token, sessionId: propSessionId, openUrl }: RemoteControlProps, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const [isConnected, setIsConnected] = useState<boolean>(false);
    const keepAliveIntervalRef = useRef<number | undefined>(undefined);
    const pendingScreenshotResolversRef = useRef<
      Map<string, (value: ScreenshotData | PromiseLike<ScreenshotData>) => void>
    >(new Map());
    const pendingScreenshotRejectersRef = useRef<Map<string, (reason?: any) => void>>(new Map());

    // Map to track active pointers (mouse or touch) and their last known position inside the video
    // Key: pointerId (-1 for mouse, touch.identifier for touch), Value: { x: number, y: number }
    const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

    const sessionId = useMemo(
      () =>
        propSessionId ||
        Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
      [propSessionId],
    );

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

    // Unified handler for both mouse and touch interactions
    const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open' || !videoRef.current) {
        return;
      }

      const video = videoRef.current;
      const rect = video.getBoundingClientRect();
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;

      if (!videoWidth || !videoHeight) return; // Video dimensions not ready

      // Helper to process a single pointer event (either mouse or a single touch point)
      const processPointer = (
        pointerId: number,
        clientX: number,
        clientY: number,
        eventType: 'down' | 'move' | 'up' | 'cancel',
      ) => {
        // --- Start: Coordinate Calculation ---
        const displayWidth = rect.width;
        const displayHeight = rect.height;
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
        const relativeX = clientX - rect.left - offsetX;
        const relativeY = clientY - rect.top - offsetY;
        const isInside =
          relativeX >= 0 && relativeX <= actualWidth && relativeY >= 0 && relativeY <= actualHeight;

        let videoX = 0;
        let videoY = 0;
        if (isInside) {
          videoX = Math.max(0, Math.min(videoWidth, (relativeX / actualWidth) * videoWidth));
          videoY = Math.max(0, Math.min(videoHeight, (relativeY / actualHeight) * videoHeight));
        }
        // --- End: Coordinate Calculation ---

        let action: number | null = null;
        let positionToSend: { x: number; y: number } | null = null;
        let pressure = 1.0; // Default pressure
        const buttons = AMOTION_EVENT.BUTTON_PRIMARY; // Assume primary button

        switch (eventType) {
          case 'down':
            if (isInside) {
              action = AMOTION_EVENT.ACTION_DOWN;
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
              action = eventType === 'cancel' ? AMOTION_EVENT.ACTION_CANCEL : AMOTION_EVENT.ACTION_UP;
              // IMPORTANT: Send the UP/CANCEL at the *last known position* inside the video
              positionToSend = activePointers.current.get(pointerId)!;
              activePointers.current.delete(pointerId); // Remove pointer as it's no longer active
            }
            break;
        }

        // Send message if action and position determined
        if (action !== null && positionToSend !== null) {
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
            sendBinaryControlMessage(message);
          }
        } else if (eventType === 'up' || eventType === 'cancel') {
          // Clean up map just in case if 'down' was outside and 'up'/'cancel' is triggered
          activePointers.current.delete(pointerId);
        }
      };

      // --- Event Type Handling ---

      if ('touches' in event) {
        // Touch Events
        const touches = event.changedTouches; // Use changedTouches for start/end/cancel
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
            return; // Should not happen
        }

        for (let i = 0; i < touches.length; i++) {
          const touch = touches[i];
          processPointer(touch.identifier, touch.clientX, touch.clientY, eventType);
        }
      } else {
        // Mouse Events
        const pointerId = -1; // Use -1 for mouse pointer
        let eventType: 'down' | 'move' | 'up' | 'cancel' | null = null;

        switch (event.type) {
          case 'mousedown':
            if (event.button === 0) eventType = 'down'; // Only primary button
            break;
          case 'mousemove':
            // Only process move if primary button is down (check map)
            if (activePointers.current.has(pointerId)) {
              eventType = 'move';
            }
            break;
          case 'mouseup':
            if (event.button === 0) eventType = 'up'; // Only primary button
            break;
          case 'mouseleave':
            // Treat leave like up only if button was down
            if (activePointers.current.has(pointerId)) {
              eventType = 'up';
            }
            break;
        }

        if (eventType) {
          processPointer(pointerId, event.clientX, event.clientY, eventType);
        }
      }
    };

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
          setIsConnected(peerConnectionRef.current?.connectionState === 'connected');
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
      setIsConnected(false);
      updateStatus('Stopped');
    };

    useEffect(() => {
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
    }));

    return (
      <div
        className={clsx(
          'rc-container', // Use custom CSS class instead of Tailwind
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
        <video
          ref={videoRef}
          className="rc-video"
          autoPlay
          playsInline
          muted
          tabIndex={0}
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
        <img
          src="/iphone16pro_black.webp"
          alt=""
          className="rc-phone-frame"
          draggable={false}
        />
        {!isConnected && (
          <div className="rc-placeholder-wrapper">
            <div className="rc-spinner"></div>
            <p className="rc-placeholder-content">Connecting...</p>
          </div>
        )}
      </div>
    );
  },
);
