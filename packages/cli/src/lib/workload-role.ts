import { assetNameTarget, assetUploadPermissions } from '@limrun/api';

/** Resolve creation-time grants before sending the instance request. */
export function workloadRoleFromFlags(flags: Record<string, unknown>): { permissions: string[] } | undefined {
  const provided = flags.permission as string[] | undefined;
  const name = flags.upload ?? flags['auto-upload'];
  if (typeof name === 'string' && name) {
    if (flags['signed-upload-url']) throw new Error('Use either --upload or --signed-upload-url, not both.');
    return { permissions: assetUploadPermissions({ target: assetNameTarget(name) }, provided) };
  }
  return provided === undefined ? undefined : { permissions: [...new Set(provided)] };
}
