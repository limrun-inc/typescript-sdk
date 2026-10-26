export type AssetAction = 'read' | 'create' | 'upload' | 'update' | 'delete' | 'all';

/** Encode an exact name for a permission or an assetUpload target. */
export function assetNameTarget(name: string): string {
  return `name/${encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

export function assetPermission(target: string, action: AssetAction): string {
  return `asset:${target}:${action}`;
}

/** Uploaded by the daemon after the build, using fresh workload credentials unless token is supplied. */
export interface AssetUpload {
  target: string;
  token?: string;
}

/** @deprecated Use assetPermission. */
export const assetScope = assetPermission;
