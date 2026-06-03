export const appConfigKeyPattern = /^[A-Z0-9_]+$/;

const maxAppConfigCount = 32;
const maxAppConfigValueBytes = 4096;
const maxAppConfigTotalBytes = 65536;

function validateAppConfigKey(key: string): void {
  if (key.startsWith('APP_CONFIG_')) {
    throw new Error(
      `invalid app config key "${key}": must not include the APP_CONFIG_ prefix, it is added automatically`,
    );
  }
  if (!appConfigKeyPattern.test(key)) {
    throw new Error(`invalid app config key "${key}": keys must match ^[A-Z0-9_]+$`);
  }
}

export function validateAppConfig(config: Record<string, string>): void {
  const entries = Object.entries(config);
  if (entries.length > maxAppConfigCount) {
    throw new Error(`too many app config entries: got ${entries.length}, max ${maxAppConfigCount}`);
  }

  let totalBytes = 0;
  for (const [key, value] of entries) {
    validateAppConfigKey(key);
    if (typeof value !== 'string') {
      throw new Error(`invalid app config value for "${key}": value must be a string`);
    }
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > maxAppConfigValueBytes) {
      throw new Error(
        `app config value for "${key}" is too large: got ${valueBytes} bytes, max ${maxAppConfigValueBytes} bytes`,
      );
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + valueBytes;
    if (totalBytes > maxAppConfigTotalBytes) {
      throw new Error(`app config payload is too large: max ${maxAppConfigTotalBytes} bytes`);
    }
  }
}

export function parseAppConfigEntries(entries: readonly string[]): Record<string, string> | undefined {
  const config: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`invalid app config entry "${entry}": expected KEY=VALUE`);
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (!key) {
      throw new Error(`invalid app config entry "${entry}": key is required`);
    }
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error(`duplicate app config key "${key}"`);
    }
    config[key] = value;
  }
  if (Object.keys(config).length === 0) {
    return undefined;
  }
  validateAppConfig(config);
  return config;
}
