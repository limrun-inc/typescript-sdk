/**
 * Maps repeatable curl-style --tunnel-header 'Name: value' entries onto the
 * create spec's tunnelHeaders. It checks only the shape and duplicate names;
 * the API enforces the rest, such as limits and reserved names.
 *
 * Duplicate names are rejected case-insensitively, because header names are
 * case-insensitive on the wire and one would silently replace the other.
 */
export function parseTunnelHeaders(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const headers: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [index, entry] of values.entries()) {
    const separator = entry.indexOf(':');
    const name = separator > 0 ? entry.slice(0, separator).trim() : '';
    if (!name) {
      // Reported by position, never echoed: the entry may carry a sensitive value.
      throw new Error(`--tunnel-header #${index + 1} must look like 'Name: value'.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate --tunnel-header name ${JSON.stringify(name)}.`);
    }
    seen.add(key);
    headers.push([name, entry.slice(separator + 1).trim()]);
  }
  // fromEntries keeps a name such as __proto__ an own key, for the API to judge.
  return Object.fromEntries(headers);
}
