/** A comma that is not escaped as `\,`. */
const ENTRY_SEPARATOR = /(?<!\\),/;

/**
 * Default for a `multiple: true` flag whose entries can come from an
 * environment variable, as comma-separated values.
 *
 * Use this rather than the flag's `env` property: oclif passes an env-sourced
 * value to a `multiple` flag unsplit and unwrapped (@oclif/core 4.13), so the
 * flag's declared string[] would hold a bare string and every consumer would
 * iterate it by character. A `default` returning the parsed array keeps the
 * declared type honest, and argv still wins because oclif resolves tokens
 * before defaults.
 *
 * Values legitimately contain commas (an AWS SigV4 Authorization header is
 * full of them), so a literal one is written `\,`, matching how oclif
 * unescapes its own delimited flags. Empty segments are dropped, since a
 * wrapper concatenating the variable routinely leaves a trailing separator.
 */
export function repeatableFlagFromEnv(variable: string): string[] | undefined {
  const raw = process.env[variable];
  if (!raw) {
    return undefined;
  }
  const entries = raw
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim().replace(/\\,/g, ','))
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}
