// Endpoint URLs handed to <RemoteControl> may already carry provider query
// parameters (e.g. `?transport=webrtc`), and the token is an opaque string
// that can contain characters which are URL syntax (`&`, `=`, spaces).
// Building the authenticated URL through `URL`/`URLSearchParams` keeps the
// existing parameters intact, encodes the token as a single value, and
// replaces (rather than duplicates) any token already on the URL.
export const withAuthenticationToken = (url: string, token: string): string => {
  const endpoint = new URL(url);
  endpoint.searchParams.set('token', token);
  return endpoint.toString();
};
