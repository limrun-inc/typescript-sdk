// Structural validation only. The server is authoritative on which build
// settings are allowed (an allowlist of safe standard settings plus the
// APP_CONFIG_* namespace), so the client checks only shape and size and lets
// the server reject disallowed keys. This keeps the allowlist server-side, so
// adding a setting does not require an SDK release.
export const buildSettingKeyPattern = /^[A-Z0-9_]+$/;

const maxBuildSettingCount = 32;
const maxBuildSettingValueBytes = 4096;
const maxBuildSettingTotalBytes = 65536;

export function validateBuildSettings(settings: Record<string, string>): void {
  const entries = Object.entries(settings);
  if (entries.length > maxBuildSettingCount) {
    throw new Error(`too many build settings: got ${entries.length}, max ${maxBuildSettingCount}`);
  }

  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (!buildSettingKeyPattern.test(key)) {
      throw new Error(`invalid build setting key "${key}": keys must match ^[A-Z0-9_]+$`);
    }
    if (typeof value !== 'string') {
      throw new Error(`invalid build setting value for "${key}": value must be a string`);
    }
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > maxBuildSettingValueBytes) {
      throw new Error(
        `build setting value for "${key}" is too large: got ${valueBytes} bytes, max ${maxBuildSettingValueBytes} bytes`,
      );
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + valueBytes;
    if (totalBytes > maxBuildSettingTotalBytes) {
      throw new Error(`build settings payload is too large: max ${maxBuildSettingTotalBytes} bytes`);
    }
  }
}

export function parseBuildSettingEntries(entries: readonly string[]): Record<string, string> | undefined {
  const settings: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`invalid build setting "${entry}": expected KEY=VALUE`);
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (!key) {
      throw new Error(`invalid build setting "${entry}": key is required`);
    }
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      throw new Error(`duplicate build setting key "${key}"`);
    }
    settings[key] = value;
  }
  if (Object.keys(settings).length === 0) {
    return undefined;
  }
  validateBuildSettings(settings);
  return settings;
}
