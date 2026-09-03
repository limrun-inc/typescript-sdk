export { RemoteControl } from './components/remote-control';
export type {
  RemoteControlProps,
  RemoteControlHandle,
  MicrophoneState,
  CameraStreamStats,
} from './components/remote-control';
export type {
  CameraCaptureInfo,
  CameraFacingMode,
  CameraRequest,
  CameraResolutionCap,
  CameraResult,
} from './core/camera';

// Accessibility / inspect-mode types and helpers. Exported so customers can
// build their own side panels, search UIs, or agent-driven inspectors on top
// of the snapshots delivered via `onAxSnapshotChange`.
export type { AxSnapshot, AxElement, AxRect, AxSelectors, AxPlatform } from './core/ax-tree';
export type { AndroidElementTreeOptions, AxStatus } from './core/ax-fetcher';
export {
  axElementAtPoint,
  axElementSelectorExpression,
  axElementSummary,
  axElementsEqual,
  axSnapshotsEqual,
  clampAxFrameForScreen,
  normalizeAndroidTree,
  normalizeIosTree,
  AX_UNAVAILABLE_ERROR,
} from './core/ax-tree';
