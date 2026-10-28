export type AssetAction = 'read' | 'create' | 'upload' | 'update' | 'delete' | 'all';

/** Encode an exact name for a permission or an assetUpload target. */
function encodeAssetNameTarget(name: string): string {
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
  /** Asset expiry as a Go duration. Build uploads default to 336h. */
  ttl?: string;
  /** Metadata applied before the upload. Requires update permission. */
  uploadOptions?: AssetUploadMetadata;
}

/** @deprecated Use assetPermission. */
export const assetScope = assetPermission;

export interface AssetUploadMetadata {
  displayName?: string;
  bundleIdentifier?: string;
  shortVersion?: string;
  buildVersion?: string;
  deeplink?: string;
}

export type BuildUpload =
  | (AssetUpload & { assetName?: never; signedUploadUrl?: never })
  | {
      signedUploadUrl: string;
      target?: never;
      assetName?: never;
      ttl?: never;
      token?: never;
      uploadOptions?: never;
    }
  | {
      /** @deprecated Use a literal target such as "name/result.apk". Authorization now happens in the workload. */
      assetName: string;
      ttl?: string;
      uploadOptions?: AssetUploadMetadata;
      target?: never;
      signedUploadUrl?: never;
      token?: never;
    };

export const DEFAULT_BUILD_ASSET_TTL = '336h';

/** Normalize compatibility names without requesting an asset URL on the client. */
export function normalizeAssetUpload(upload: BuildUpload): AssetUpload | undefined {
  const modes = [upload.target, upload.assetName, upload.signedUploadUrl].filter((v) => v !== undefined);
  if (modes.length !== 1) throw new Error('Provide exactly one upload target or signedUploadUrl');
  if (upload.signedUploadUrl !== undefined) {
    if (!upload.signedUploadUrl) throw new Error('signedUploadUrl must not be empty');
    return undefined;
  }
  if (upload.assetName === '') throw new Error('assetName must not be empty');
  const target = upload.target ?? encodeAssetNameTarget(upload.assetName!);
  if (target.startsWith('name/')) {
    const name = decodeURIComponent(target.slice(5));
    if (!name || encodeAssetNameTarget(name) !== target)
      throw new Error('Name targets must use name/ followed by a canonical percent-encoded exact name');
  } else if (!/^asset_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(target)) {
    throw new Error('Upload target must be an asset ID or an exact name target');
  }
  if (upload.token !== undefined && !upload.token.trim()) throw new Error('Upload token must not be empty');
  return {
    target,
    ttl: upload.ttl || DEFAULT_BUILD_ASSET_TTL,
    ...(upload.token !== undefined && { token: upload.token }),
    ...(upload.uploadOptions !== undefined && { uploadOptions: upload.uploadOptions }),
  };
}
