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

/**
 * The instance's HTTP port URL prefix, derived from its API URL: the two share
 * the instance path and differ only in the last segment (`/api` vs
 * `/targetHttpPort`). An instance known only by apiUrl + token carries no
 * prefix, and looking it up would need an API key. Undefined when the URL does
 * not end in `/api`.
 */
export function targetHttpPortUrlPrefixFromApiUrl(apiUrl: string): string | undefined {
  const match = /^(.*)\/api\/?$/.exec(apiUrl);
  return match ? `${match[1]}/targetHttpPort` : undefined;
}
