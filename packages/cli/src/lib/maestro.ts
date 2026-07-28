// The patched runner has proven version-agnostic so far: Maestro CLI 2.7.0
// drives this 2.5.1-built runner including the newer endpoints (swipeV2,
// isScreenStatic, setOrientation). Bump only when a CLI release actually
// requires a newer runner.
export const MAESTRO_RUNNER_ASSET_NAME = 'appstore/maestro-ios-runner-2.5.1.tar.gz';

// Flags `lim ios maestro` injects itself; user-provided duplicates would make
// maestro's picocli parser fail with a confusing error.
export const INJECTED_MAESTRO_FLAGS = [
  '--platform',
  '-p',
  '--device',
  '--udid',
  '--no-reinstall-driver',
  '--driver-host-port',
];
