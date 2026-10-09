/** Validate app variables before sending them to the simulator. The server also enforces this policy. */
export function validateLaunchEnvironment(env: Record<string, string>): void {
  const entries = Object.entries(env);
  if (entries.length > 64) throw new Error('launch environment can contain at most 64 entries');
  let total = 0;
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) {
      throw new Error('launch environment key is invalid');
    }
    if (
      /^(DYLD_|__DYLD_|LD_|__XPC_|XPC_DYLD_|SWIFT_DEBUG_|SIMCTL_CHILD_)/i.test(key) ||
      key.toUpperCase() === 'LIMRUN_INSERT_LIBRARIES'
    ) {
      throw new Error(`launch environment key is reserved: ${key}`);
    }
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      throw new Error(`launch environment value is invalid for key: ${key}`);
    }
    total += new TextEncoder().encode(key + value).length;
  }
  if (total > 64 * 1024)
    throw new Error('launch environment keys and values can be at most 65536 bytes in total');
}

/** Parse repeatable KEY=VALUE entries; the last occurrence of a key wins. */
export function parseLaunchEnvironment(entries: string[]): Record<string, string> {
  const env = Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('launch environment must use KEY=VALUE');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  validateLaunchEnvironment(env);
  return env;
}
