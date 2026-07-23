/** Strips dashes and any non-hex characters from a device UDID. */
export function normalizeUDID(udid?: string) {
  return (udid ?? '').replace(/-/g, '').replace(/[^a-fA-F0-9]/g, '');
}

/** Case-insensitive UDID comparison; empty or missing UDIDs never match. */
export function sameUDID(left?: string, right?: string) {
  const a = normalizeUDID(left).toUpperCase();
  const b = normalizeUDID(right).toUpperCase();
  return !!a && a === b;
}
