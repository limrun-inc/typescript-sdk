/** A download URL, or an asset the instance has delegated permission to read. */
export type AssetSource = string | { assetName: string; url?: never };

export function assetSourceFields(source: AssetSource): { url: string } | { assetName: string } {
  if (typeof source === 'string') {
    if (!source) throw new Error('url must not be empty');
    return { url: source };
  }
  if (!source || typeof source.assetName !== 'string' || !source.assetName || 'url' in source) {
    throw new Error('Provide a URL string or { assetName: <non-empty name> }');
  }
  return { assetName: source.assetName };
}
