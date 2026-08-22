/**
 * Validates --env entries (KEY=VALUE) and returns them in flag order, or
 * undefined when none were passed. Order is preserved because the server
 * keeps duplicates and the last occurrence of a key wins, matching shell
 * semantics. Server-managed variables (PATH, HOME, ...) cannot be
 * overridden; the server ignores colliding entries.
 */
export function parseEnvEntries(entries: string[], fail: (message: string) => never): string[] | undefined {
  if (entries.length === 0) return undefined;
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      fail(`Invalid --env value ${JSON.stringify(entry)}; expected KEY=VALUE.`);
    }
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(`Invalid environment variable name ${JSON.stringify(key)}.`);
    }
  }
  return [...entries];
}
