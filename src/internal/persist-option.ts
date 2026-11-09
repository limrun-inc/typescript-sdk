/**
 * Whether a capture is persisted to Limrun's bucket after it stops.
 * `true` persists with the server default TTL (72h); pass an object to set
 * the TTL in seconds (capped server-side).
 */
export type PersistOption = boolean | { ttlSeconds?: number };

/** Wire fields a persist option turns into on a start-capture message. */
export function persistFields(persist: PersistOption | undefined): {
  persist?: boolean;
  ttlSeconds?: number;
} {
  if (!persist) {
    return {};
  }
  if (persist === true) {
    return { persist: true };
  }
  return { persist: true, ...ttlFields(persist.ttlSeconds) };
}

/** The ttlSeconds wire field of a persisted capture, checked before it is sent. */
export function ttlFields(ttlSeconds: number | undefined): { ttlSeconds?: number } {
  if (ttlSeconds === undefined) {
    return {};
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer');
  }
  return { ttlSeconds };
}
