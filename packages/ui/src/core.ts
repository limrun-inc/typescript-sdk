export { createDeviceStream, type DeviceStream } from './core/device-stream';
export type {
  DeviceStreamOptions,
  DeviceStreamLiveOptions,
  DeviceStreamState,
  DeviceStreamTransport,
  DeviceFrameSink,
  StreamDisplay,
} from './core/stream-options';
export type {
  RemoteControlConnectionState,
  ImperativeKeyboardEvent,
  ScreenshotData,
  MicrophoneState,
  CameraStreamStats,
} from './core/stream-types';
export type {
  PlaybackStats,
  PlaybackVideoStats,
  PlaybackAudioStats,
  PlaybackTrackStats,
} from './core/playback-stats';
export type { CameraCaptureInfo, CameraFacingMode, CameraRequest, CameraResult } from './core/camera';
export type { AxSnapshot, AxElement } from './core/ax-tree';
export type { AndroidElementTreeOptions, AxStatus } from './core/ax-fetcher';
export type { DuoState, DuoOrientation } from './core/duo';
export {
  createTouchControlMessage,
  createTwoFingerTouchControlMessage,
  createInjectKeycodeMessage,
  createSetClipboardMessage,
} from './core/webrtc-messages';
export { createDisplayTouchMessage } from './core/duo';
export { ANDROID_KEYS, AMOTION_EVENT, CONTROL_MSG_TYPE } from './core/constants';
