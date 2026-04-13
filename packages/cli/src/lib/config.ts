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
