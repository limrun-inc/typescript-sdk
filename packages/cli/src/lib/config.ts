import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const CONFIG_DIR = path.join(os.homedir(), '.lim');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

export const CONFIG_KEYS = {
  apiKey: 'api-key',
  apiEndpoint: 'api-endpoint',
  consoleEndpoint: 'console-endpoint',
} as const;

const DEFAULTS: Record<string, string> = {
  [CONFIG_KEYS.apiEndpoint]: 'https://api.limrun.com',
  [CONFIG_KEYS.consoleEndpoint]: 'https://console.limrun.com',
};

export interface LimConfig {
  apiKey: string;
  apiEndpoint: string;
  consoleEndpoint: string;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readRawConfig(): Record<string, string> {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const parsed = yaml.load(content);
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed as Record<string, string>;
  }
  return {};
}

function writeRawConfig(config: Record<string, string>): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, yaml.dump(config), { mode: 0o600 });
}

export function readConfig(): LimConfig {
  const raw = readRawConfig();
  return {
    apiKey: process.env.LIM_API_KEY || raw[CONFIG_KEYS.apiKey] || '',
    apiEndpoint:
      process.env.LIM_API_ENDPOINT || raw[CONFIG_KEYS.apiEndpoint] || DEFAULTS[CONFIG_KEYS.apiEndpoint],
    consoleEndpoint:
      process.env.LIM_CONSOLE_ENDPOINT ||
      raw[CONFIG_KEYS.consoleEndpoint] ||
      DEFAULTS[CONFIG_KEYS.consoleEndpoint],
  };
}

export function writeConfig(partial: Partial<Record<string, string>>): void {
  const raw = readRawConfig();
  Object.assign(raw, partial);
  writeRawConfig(raw);
}

export function clearApiKey(): void {
  const raw = readRawConfig();
  delete raw[CONFIG_KEYS.apiKey];
  writeRawConfig(raw);
}

// ---------- Last used instance per type ----------

const LAST_INSTANCE_FILE = path.join(CONFIG_DIR, 'last-instances.json');

interface LastInstances {
  ios?: string;
  android?: string;
  xcode?: string;
}

function readLastInstances(): LastInstances {
  if (!fs.existsSync(LAST_INSTANCE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LAST_INSTANCE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveLastInstanceId(instanceId: string): void {
  ensureConfigDir();
  const rawPrefix = instanceId.split('_')[0];
  // Map sandbox_ prefix to xcode type
  const prefix = (rawPrefix === 'sandbox' ? 'xcode' : rawPrefix) as keyof LastInstances;
  const data = readLastInstances();
  data[prefix] = instanceId;
  fs.writeFileSync(LAST_INSTANCE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadLastInstanceId(type?: string): string | null {
  const data = readLastInstances();
  if (type) return data[type as keyof LastInstances] ?? null;
  // Return the most recently saved one (check all types)
  // Since we can't track order, prefer ios > android > xcode as a reasonable default
  return data.ios ?? data.android ?? data.xcode ?? null;
}

/**
 * Resolve an instance ID from explicit arg, active session, or last-used fallback.
 * Throws with a helpful message if no ID can be determined.
 */
export function resolveInstanceId(providedId: string | undefined, expectedType?: string): string {
  if (providedId) return providedId;

  // Try last-used instance for the expected type
  const lastId = loadLastInstanceId(expectedType);
  if (lastId) return lastId;

  const typeHint = expectedType ? ` ${expectedType}` : '';
  throw new Error(
    `No instance ID provided and no recent${typeHint} instance found.\n` +
      `Provide an instance ID or create one first with: lim${typeHint} create`,
  );
}

// ---------- Instance metadata cache ----------
// Stores data from create responses that the API doesn't return on get
// (e.g. sandbox.xcode.url for iOS instances)

const INSTANCES_DIR = path.join(CONFIG_DIR, 'instances');

export interface InstanceCache {
  sandboxXcodeUrl?: string;
  token?: string;
}

function instanceCachePath(instanceId: string): string {
  // Sanitize ID for use as filename
  return path.join(INSTANCES_DIR, `${instanceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function saveInstanceCache(instanceId: string, data: InstanceCache): void {
  ensureConfigDir();
  if (!fs.existsSync(INSTANCES_DIR)) {
    fs.mkdirSync(INSTANCES_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(instanceCachePath(instanceId), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadInstanceCache(instanceId: string): InstanceCache | null {
  const p = instanceCachePath(instanceId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearInstanceCache(instanceId: string): void {
  try {
    fs.unlinkSync(instanceCachePath(instanceId));
  } catch {}
}
