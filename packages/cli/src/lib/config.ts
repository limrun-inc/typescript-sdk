import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { type AndroidInstance } from '@limrun/api/resources/android-instances';
import { type IosInstance } from '@limrun/api/resources/ios-instances';
import { type XcodeInstance } from '@limrun/api/resources/xcode-instances';

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
    apiKey: process.env['LIM_API_KEY'] || raw[CONFIG_KEYS.apiKey] || '',
    apiEndpoint:
      process.env['LIM_API_ENDPOINT'] || raw[CONFIG_KEYS.apiEndpoint] || DEFAULTS[CONFIG_KEYS.apiEndpoint]!,
    consoleEndpoint:
      process.env['LIM_CONSOLE_ENDPOINT'] ||
      raw[CONFIG_KEYS.consoleEndpoint] ||
      DEFAULTS[CONFIG_KEYS.consoleEndpoint]!,
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

export interface LastAndroidInstance {
  id: string;
  type: 'android';
  metadata?: AndroidInstance.Metadata;
  spec?: AndroidInstance.Spec;
  status?: AndroidInstance.Status;
  apiUrl?: AndroidInstance.Status['apiUrl'];
  token?: AndroidInstance.Status['token'];
  adbWebSocketUrl?: AndroidInstance.Status['adbWebSocketUrl'];
  endpointWebSocketUrl?: AndroidInstance.Status['endpointWebSocketUrl'];
  mcpUrl?: AndroidInstance.Status['mcpUrl'];
  signedStreamUrl?: AndroidInstance.Status['signedStreamUrl'];
  targetHttpPortUrlPrefix?: AndroidInstance.Status['targetHttpPortUrlPrefix'];
}

export interface LastIosInstance {
  id: string;
  type: 'ios';
  metadata?: IosInstance.Metadata;
  spec?: IosInstance.Spec;
  status?: IosInstance.Status;
  apiUrl?: IosInstance.Status['apiUrl'];
  token?: IosInstance.Status['token'];
  endpointWebSocketUrl?: IosInstance.Status['endpointWebSocketUrl'];
  mcpUrl?: IosInstance.Status['mcpUrl'];
  signedStreamUrl?: IosInstance.Status['signedStreamUrl'];
  targetHttpPortUrlPrefix?: IosInstance.Status['targetHttpPortUrlPrefix'];
  sandboxXcodeUrl?: NonNullable<NonNullable<IosInstance.Status['sandbox']>['xcode']>['url'];
}

export interface LastXcodeInstance {
  id: string;
  type: 'xcode';
  metadata?: XcodeInstance.Metadata;
  spec?: XcodeInstance.Spec;
  status?: XcodeInstance.Status;
  apiUrl?: XcodeInstance.Status['apiUrl'];
  token?: XcodeInstance.Status['token'];
}

interface LastInstances {
  ios?: LastIosInstance;
  android?: LastAndroidInstance;
  xcode?: LastIosInstance | LastXcodeInstance;
}

function readLastInstances(): LastInstances {
  if (!fs.existsSync(LAST_INSTANCE_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(LAST_INSTANCE_FILE, 'utf-8'));
    if (isLastInstances(parsed)) {
      return parsed;
    }
  } catch {}
  deleteLastInstancesFile();
  return {};
}

function deleteLastInstancesFile(): void {
  try {
    fs.unlinkSync(LAST_INSTANCE_FILE);
  } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLastAndroidInstance(value: unknown): value is LastAndroidInstance {
  return isRecord(value) && value['type'] === 'android' && typeof value['id'] === 'string';
}

function isLastIosInstance(value: unknown): value is LastIosInstance {
  return isRecord(value) && value['type'] === 'ios' && typeof value['id'] === 'string';
}

function isLastXcodeInstance(value: unknown): value is LastXcodeInstance {
  return isRecord(value) && value['type'] === 'xcode' && typeof value['id'] === 'string';
}

function isLastInstances(value: unknown): value is LastInstances {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['ios', 'android', 'xcode'].includes(key))) return false;
  if (value['android'] !== undefined && !isLastAndroidInstance(value['android'])) return false;
  if (value['ios'] !== undefined && !isLastIosInstance(value['ios'])) return false;
  if (
    value['xcode'] !== undefined &&
    !isLastIosInstance(value['xcode']) &&
    !isLastXcodeInstance(value['xcode'])
  ) {
    return false;
  }
  return true;
}

function detectLastInstanceType(instanceId: string): 'ios' | 'android' | 'xcode' {
  const rawPrefix = instanceId.split('_')[0];
  if (rawPrefix === 'android') return 'android';
  if (rawPrefix === 'ios') return 'ios';
  return 'xcode';
}

function isAndroidInstance(instance: InstanceInput): instance is AndroidInstance {
  return detectLastInstanceType(instance.metadata.id) === 'android';
}

function isIosInstance(instance: InstanceInput): instance is IosInstance {
  return detectLastInstanceType(instance.metadata.id) === 'ios';
}

function isXcodeInstance(instance: InstanceInput): instance is XcodeInstance {
  return detectLastInstanceType(instance.metadata.id) === 'xcode';
}

export type InstanceInput = AndroidInstance | IosInstance | XcodeInstance;

function buildLastInstanceRecord(
  instanceOrId: InstanceInput,
): LastAndroidInstance | LastIosInstance | LastXcodeInstance {
  const id = instanceOrId.metadata.id;
  if (isAndroidInstance(instanceOrId)) {
    return {
      id,
      type: 'android',
      metadata: instanceOrId.metadata,
      spec: instanceOrId.spec,
      status: instanceOrId.status,
      apiUrl: instanceOrId.status.apiUrl,
      token: instanceOrId.status.token,
      adbWebSocketUrl: instanceOrId.status.adbWebSocketUrl,
      endpointWebSocketUrl: instanceOrId.status.endpointWebSocketUrl,
      mcpUrl: instanceOrId.status.mcpUrl,
      signedStreamUrl: instanceOrId.status.signedStreamUrl,
      targetHttpPortUrlPrefix: instanceOrId.status.targetHttpPortUrlPrefix,
    };
  }
  if (isIosInstance(instanceOrId)) {
    return {
      id,
      type: 'ios',
      metadata: instanceOrId.metadata,
      spec: instanceOrId.spec,
      status: instanceOrId.status,
      apiUrl: instanceOrId.status.apiUrl,
      token: instanceOrId.status.token,
      endpointWebSocketUrl: instanceOrId.status.endpointWebSocketUrl,
      mcpUrl: instanceOrId.status.mcpUrl,
      signedStreamUrl: instanceOrId.status.signedStreamUrl,
      targetHttpPortUrlPrefix: instanceOrId.status.targetHttpPortUrlPrefix,
      sandboxXcodeUrl: instanceOrId.status.sandbox?.xcode?.url,
    };
  }
  if (isXcodeInstance(instanceOrId)) {
    return {
      id,
      type: 'xcode',
      metadata: instanceOrId.metadata,
      spec: instanceOrId.spec,
      status: instanceOrId.status,
      apiUrl: instanceOrId.status.apiUrl,
      token: instanceOrId.status.token,
    };
  }

  return {
    id,
    type: 'xcode',
  };
}

function saveLastInstance(instanceOrId: InstanceInput, slot?: 'xcode'): void {
  ensureConfigDir();
  const record = buildLastInstanceRecord(instanceOrId);
  const data = readLastInstances();
  if (slot === 'xcode') {
    if (record.type === 'ios' || record.type === 'xcode') {
      data.xcode = record;
    }
  } else if (record.type === 'android') {
    data.android = record;
  } else if (record.type === 'ios') {
    data.ios = record;
  } else {
    data.xcode = record;
  }
  fs.writeFileSync(LAST_INSTANCE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function registerCreatedInstance(
  instanceOrId: InstanceInput,
  relatedTypes: Array<'xcode'> = [],
): void {
  saveLastInstance(instanceOrId);
  if (relatedTypes.includes('xcode')) {
    saveLastInstance(instanceOrId, 'xcode');
  }
}

export function loadLastAndroidInstance(): LastAndroidInstance | null {
  const data = readLastInstances();
  return data.android ?? null;
}

export function loadLastIosInstance(): LastIosInstance | null {
  const data = readLastInstances();
  return data.ios ?? null;
}

export function loadLastXcodeInstance(): LastIosInstance | LastXcodeInstance | null {
  const data = readLastInstances();
  return data.xcode ?? null;
}

export function clearLastInstanceId(instanceId: string): void {
  const data = readLastInstances();
  let changed = false;
  for (const key of Object.keys(data) as (keyof LastInstances)[]) {
    if (data[key]?.id === instanceId) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) {
    ensureConfigDir();
    fs.writeFileSync(LAST_INSTANCE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

export function saveInstanceCache(
  instanceId: string,
  data: Partial<LastAndroidInstance> | Partial<LastIosInstance> | Partial<LastXcodeInstance>,
): void {
  const lastInstances = readLastInstances();
  let changed = false;
  if (lastInstances.android?.id === instanceId) {
    lastInstances.android = {
      ...lastInstances.android,
      ...(data as Partial<LastAndroidInstance>),
      type: 'android',
    };
    changed = true;
  }
  if (lastInstances.ios?.id === instanceId) {
    lastInstances.ios = {
      ...lastInstances.ios,
      ...(data as Partial<LastIosInstance>),
      type: 'ios',
    };
    changed = true;
  }
  if (lastInstances.xcode?.id === instanceId) {
    lastInstances.xcode =
      lastInstances.xcode.type === 'ios' ?
        { ...lastInstances.xcode, ...(data as Partial<LastIosInstance>), type: 'ios' }
      : { ...lastInstances.xcode, ...(data as Partial<LastXcodeInstance>), type: 'xcode' };
    changed = true;
  }
  if (changed) {
    ensureConfigDir();
    fs.writeFileSync(LAST_INSTANCE_FILE, JSON.stringify(lastInstances, null, 2), { mode: 0o600 });
  }
}

export function loadAndroidInstanceCache(instanceId: string): LastAndroidInstance | null {
  const record = readLastInstances().android;
  return record?.id === instanceId ? record : null;
}

export function loadIosInstanceCache(instanceId: string): LastIosInstance | null {
  const data = readLastInstances();
  if (data.ios?.id === instanceId) return data.ios;
  if (data.xcode?.type === 'ios' && data.xcode.id === instanceId) return data.xcode;
  return null;
}

export function loadXcodeInstanceCache(instanceId: string): LastXcodeInstance | null {
  const record = readLastInstances().xcode;
  return record?.type === 'xcode' && record.id === instanceId ? record : null;
}
