export { RemoteControl } from './components/remote-control';
export type { RemoteControlHandle } from './components/remote-control';

// Accessibility / inspect-mode types and helpers. Exported so customers can
// build their own side panels, search UIs, or agent-driven inspectors on top
// of the snapshots delivered via `onAxSnapshotChange`.
export type { AxSnapshot, AxElement, AxRect, AxSelectors, AxPlatform } from './core/ax-tree';
export type { AxStatus } from './core/ax-fetcher';
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

export { DeviceInstallDialog, DeviceInstallRelay } from './components/device-install';
export { useDeviceInstall } from './hooks/use-device-install';