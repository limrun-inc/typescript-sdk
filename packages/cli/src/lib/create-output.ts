// Keep signed viewing links out of creation output without changing the cached resource.
export function createdInstanceOutput<T extends { status: object }>(instance: T, consoleUrl: string) {
  const status: T['status'] & { signedStreamUrl?: string } = { ...instance.status };
  delete status.signedStreamUrl;
  return { ...instance, status, consoleUrl };
}
