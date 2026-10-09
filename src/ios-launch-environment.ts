/** Parse repeatable KEY=VALUE entries; the last occurrence of a key wins. */
export function parseLaunchEnvironment(entries: string[]): Record<string, string> {
  const env = Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('launch environment must use KEY=VALUE');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
  return env;
}
