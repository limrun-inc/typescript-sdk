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
  if (
    persist.ttlSeconds !== undefined &&
    (!Number.isInteger(persist.ttlSeconds) || persist.ttlSeconds <= 0)
  ) {
    throw new Error('ttlSeconds must be a positive integer');
  }
  return { persist: true, ...(persist.ttlSeconds !== undefined && { ttlSeconds: persist.ttlSeconds }) };
}
