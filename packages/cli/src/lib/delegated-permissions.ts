import { parseSecretEnv, secretReadPermissions } from './secret-env';
/** Resolve creation-time grants before sending the instance request. */
export function delegatedPermissionsFromFlags(flags: Record<string, unknown>): string[] | undefined {
  const explicit = flags['permission'] as string[] | undefined;
  const secrets = secretReadPermissions(parseSecretEnv(flags['env-from-secret'] as string[] | undefined));
  const provided =
    explicit === undefined && secrets.length === 0 ? undefined : [...(explicit ?? []), ...secrets];
  const name = flags['upload'] ?? flags['auto-upload'];
  if (typeof name === 'string' && name) {
    if (/[*?]/.test(name))
      throw new Error(
        'Upload names must not contain * or ? because automatic permissions would grant a pattern.',
      );
    if (flags['signed-upload-url']) throw new Error('Use either --upload or --signed-upload-url, not both.');
    const target = `name/${name}`;
    // Named builds create the asset if absent and update its default expiry.
    return [
      ...new Set([
        ...(provided ?? []),
        `asset:${target}:create`,
        `asset:${target}:upload`,
        `asset:${target}:update`,
      ]),
    ];
  }
  return provided === undefined ? undefined : [...new Set(provided)];
}
