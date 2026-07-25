/** Strips dashes and any non-hex characters from a device UDID. */
export function normalizeUDID(udid?: string) {
  return (udid ?? '').replace(/-/g, '').replace(/[^a-fA-F0-9]/g, '');
}
