import { assetNameTarget, assetUploadPermissions } from '@limrun/api';

/** Resolve creation-time grants before sending the instance request. */
export function delegatedPermissionsFromFlags(flags: Record<string, unknown>): string[] | undefined {
  const provided = flags.permission as string[] | undefined;
  const name = flags.upload ?? flags['auto-upload'];
  if (typeof name === 'string' && name) {
    if (flags['signed-upload-url']) throw new Error('Use either --upload or --signed-upload-url, not both.');
    return assetUploadPermissions({ target: assetNameTarget(name) }, provided);
  }
  return provided === undefined ? undefined : [...new Set(provided)];
}
