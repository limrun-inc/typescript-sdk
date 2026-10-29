/** Resolve creation-time grants before sending the instance request. */
export function delegatedPermissionsFromFlags(flags: Record<string, unknown>): string[] | undefined {
  const provided = flags['permission'] as string[] | undefined;
  const name = flags['upload'] ?? flags['auto-upload'];
  if (typeof name === 'string' && name) {
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
