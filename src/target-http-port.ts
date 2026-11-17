/**
 * Derives an iOS instance's HTTP port URL prefix (status.targetHttpPortUrlPrefix)
 * from its API URL: the two share the instance path and differ only in the last
 * segment, `/api` versus `/targetHttpPort`. Appending a port number to the prefix
 * gives the URL of the HTTP service on that port inside the instance, so a caller
 * holding only apiUrl and token can reach it.
 *
 * Returns undefined when the URL does not end in `/api`.
 */
export function deriveTargetHttpPortUrlPrefix(apiUrl: string): string | undefined {
  const match = /^(.*)\/api\/?$/.exec(apiUrl);
  return match ? `${match[1]}/targetHttpPort` : undefined;
}
