import type { AssetUploadOptions } from '@limrun/api';

const uploadOptionKeys = [
  'displayName',
  'bundleIdentifier',
  'shortVersion',
  'buildVersion',
  'deeplink',
] as const;

/**
 * Parses repeated --upload-option key=value flags into the app metadata
 * recorded on the uploaded asset. All fields are optional; consumers like
 * the registry's OTA install flow use whichever are present.
 */
export function parseUploadOptions(values?: string[]): AssetUploadOptions | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const options: AssetUploadOptions = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error(`--upload-option must be key=value, got ${JSON.stringify(value)}`);
    }
    const key = value.slice(0, separator) as (typeof uploadOptionKeys)[number];
    if (!uploadOptionKeys.includes(key)) {
      throw new Error(
        `--upload-option key must be one of ${uploadOptionKeys.join(', ')}, got ${JSON.stringify(key)}`,
      );
    }
    options[key] = value.slice(separator + 1);
  }
  return options;
}
