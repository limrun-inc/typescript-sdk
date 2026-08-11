import type { AssetUploadOptions } from '@limrun/api';

const uploadOptionKeys = [
  'displayName',
  'bundleIdentifier',
  'shortVersion',
  'buildVersion',
  'deeplink',
] as const;

/**
 * Parses repeated --upload-options key=value flags into the app metadata
 * recorded on the uploaded asset. The registry's OTA install flow reads the
 * manifest identity from these fields, so hand-uploaded IPAs need at least
 * bundleIdentifier and buildVersion to be installable over the air.
 */
export function parseUploadOptions(values?: string[]): AssetUploadOptions | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const options: AssetUploadOptions = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`--upload-options must be key=value, got ${JSON.stringify(value)}`);
    }
    const key = value.slice(0, separator) as (typeof uploadOptionKeys)[number];
    if (!uploadOptionKeys.includes(key)) {
      throw new Error(
        `--upload-options key must be one of ${uploadOptionKeys.join(', ')}, got ${JSON.stringify(key)}`,
      );
    }
    options[key] = value.slice(separator + 1);
  }
  return options;
}
