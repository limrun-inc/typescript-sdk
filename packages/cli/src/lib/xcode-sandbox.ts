export function xcodeSandboxIdFromUrl(url: string): string | undefined {
  return url.match(/\/(sandbox_[^/]+)(?:\/|$)/)?.[1];
}
