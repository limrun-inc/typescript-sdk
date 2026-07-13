import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { type AndroidInstance } from '@limrun/api/resources/android-instances';
import { type IosInstance } from '@limrun/api/resources/ios-instances';
import { type XcodeInstance } from '@limrun/api/resources/xcode-instances';
import { type GradleInstance } from '@limrun/api/resources/gradle-instances';
import { xcodeSandboxIdFromUrl } from './xcode-sandbox';
import { getScopeKey, GLOBAL_SCOPE_KEY } from './scope';

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
const LAST_INSTANCE_LOCK = `${LAST_INSTANCE_FILE}.lock`;
const SCHEMA_VERSION = 2;
/** Reserved scope key holding pre-scoping (legacy flat-file) data until the next write migrates it. */
const LEGACY_SCOPE_KEY = '__lim_legacy__';
/** Pre-rename key for the shared non-repo slot; remapped to GLOBAL_SCOPE_KEY on read. */
const LEGACY_GLOBAL_SCOPE_KEY = '__global__';
/** Cap on how many directory scopes we retain; least-recently-used are pruned beyond this. */
const MAX_SCOPES = 200;
/** Drop scopes untouched for this long so abandoned worktrees don't accumulate. */
const SCOPE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

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

export interface LastGradleInstance {
  id: string;
  type: 'gradle';
  metadata?: GradleInstance.Metadata;
  spec?: GradleInstance.Spec;
  status?: GradleInstance.Status;
  apiUrl?: GradleInstance.Status['apiUrl'];
  token?: GradleInstance.Status['token'];
}

/** The set of last-used instances bound to a single directory scope. */
interface ScopeInstances {
  lastUsedAt?: string;
  ios?: LastIosInstance;
  android?: LastAndroidInstance;
  xcode?: LastIosInstance | LastXcodeInstance;
  gradle?: LastGradleInstance;
}

/** On-disk schema: a map of directory scope key -> its last-used instances. */
interface LastInstancesFile {
  version: number;
  scopes: Record<string, ScopeInstances>;
}

function readParsedLastInstances(): unknown {
  if (!fs.existsSync(LAST_INSTANCE_FILE)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(LAST_INSTANCE_FILE, 'utf-8'));
    } catch {
      // A concurrent atomic rename can momentarily race a read; retry once.
    }
  }
  return null;
}

function sanitizeScope(value: unknown): ScopeInstances {
  const scope: ScopeInstances = {};
  if (!isRecord(value)) return scope;
  if (typeof value['lastUsedAt'] === 'string') scope.lastUsedAt = value['lastUsedAt'];
  if (isLastAndroidInstance(value['android'])) scope.android = value['android'];
  if (isLastIosInstance(value['ios'])) scope.ios = value['ios'];
  if (isLastIosInstance(value['xcode']) || isLastXcodeInstance(value['xcode'])) {
    scope.xcode = value['xcode'] as LastIosInstance | LastXcodeInstance;
  }
  if (isLastGradleInstance(value['gradle'])) scope.gradle = value['gradle'];
  return scope;
}

function scopeHasInstance(scope: ScopeInstances): boolean {
  return Boolean(scope.ios || scope.android || scope.xcode || scope.gradle);
}

/** Copy any slots missing from `primary` out of `fallback`. */
function fillMissingScope(primary: ScopeInstances, fallback: ScopeInstances): ScopeInstances {
  const out: ScopeInstances = { ...primary };
  if (!out.ios && fallback.ios) out.ios = fallback.ios;
  if (!out.android && fallback.android) out.android = fallback.android;
  if (!out.xcode && fallback.xcode) out.xcode = fallback.xcode;
  if (!out.gradle && fallback.gradle) out.gradle = fallback.gradle;
  if (!out.lastUsedAt && fallback.lastUsedAt) out.lastUsedAt = fallback.lastUsedAt;
  return out;
}

/**
 * Parse the on-disk file into the current scoped schema. Two migrations happen
 * here so upgrades keep resolving instances without recreating them:
 *   - a legacy flat file (`{ios,android,xcode}` with no `scopes`) is surfaced
 *     under LEGACY_SCOPE_KEY (folded into the active scope on the next write), and
 *   - the pre-rename global slot key (`__global__`) is remapped onto the current
 *     GLOBAL_SCOPE_KEY (the current key wins for any overlapping slots).
 * Both are persisted on the next write.
 */
function readNormalizedFile(): LastInstancesFile {
  const parsed = readParsedLastInstances();
  const file: LastInstancesFile = { version: SCHEMA_VERSION, scopes: {} };
  if (!isRecord(parsed)) return file;

  if (typeof parsed['version'] === 'number' && isRecord(parsed['scopes'])) {
    let legacyGlobal: ScopeInstances | undefined;
    for (const [key, value] of Object.entries(parsed['scopes'])) {
      if (key === LEGACY_GLOBAL_SCOPE_KEY) {
        legacyGlobal = sanitizeScope(value);
        continue;
      }
      file.scopes[key] = sanitizeScope(value);
    }
    if (legacyGlobal && scopeHasInstance(legacyGlobal)) {
      const current = file.scopes[GLOBAL_SCOPE_KEY];
      file.scopes[GLOBAL_SCOPE_KEY] = current ? fillMissingScope(current, legacyGlobal) : legacyGlobal;
    }
    return file;
  }

  const legacy = sanitizeScope(parsed);
  if (scopeHasInstance(legacy)) {
    file.scopes[LEGACY_SCOPE_KEY] = legacy;
  }
  return file;
}

function getScopeData(file: LastInstancesFile, scopeKey: string): ScopeInstances {
  return file.scopes[scopeKey] ?? file.scopes[LEGACY_SCOPE_KEY] ?? {};
}

function readScope(scopeKey: string): ScopeInstances {
  return getScopeData(readNormalizedFile(), scopeKey);
}

function ensureScope(file: LastInstancesFile, scopeKey: string): ScopeInstances {
  let scope = file.scopes[scopeKey];
  if (!scope) {
    scope = {};
    file.scopes[scopeKey] = scope;
  }
  return scope;
}

/** Fold legacy flat-file data into the active scope (only slots not already set), once. */
function foldLegacyInto(file: LastInstancesFile, scopeKey: string): boolean {
  const legacy = file.scopes[LEGACY_SCOPE_KEY];
  if (!legacy) return false;
  delete file.scopes[LEGACY_SCOPE_KEY];
  const scope = ensureScope(file, scopeKey);
  if (!scope.android && legacy.android) scope.android = legacy.android;
  if (!scope.ios && legacy.ios) scope.ios = legacy.ios;
  if (!scope.xcode && legacy.xcode) scope.xcode = legacy.xcode;
  if (!scope.gradle && legacy.gradle) scope.gradle = legacy.gradle;
  if (!scope.lastUsedAt) scope.lastUsedAt = legacy.lastUsedAt ?? new Date().toISOString();
  return true;
}

function scopeTimestamp(scope: ScopeInstances): number {
  const ts = scope.lastUsedAt ? Date.parse(scope.lastUsedAt) : NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * Drop empty scopes, TTL-expired scopes, and the least-recently-used beyond the
 * cap. The global (non-repo) slot is exempt from TTL/LRU pruning so the "use my
 * most recent instance" fallback persists like the old single-slot behavior; it
 * is still removed once empty.
 */
function pruneScopes(file: LastInstancesFile): boolean {
  let changed = false;
  const now = Date.now();
  for (const key of Object.keys(file.scopes)) {
    if (key === LEGACY_SCOPE_KEY) continue;
    const scope = file.scopes[key]!;
    if (!scopeHasInstance(scope)) {
      delete file.scopes[key];
      changed = true;
      continue;
    }
    if (key === GLOBAL_SCOPE_KEY) continue;
    if (scope.lastUsedAt && now - scopeTimestamp(scope) > SCOPE_TTL_MS) {
      delete file.scopes[key];
      changed = true;
    }
  }
  const keys = Object.keys(file.scopes).filter((k) => k !== LEGACY_SCOPE_KEY && k !== GLOBAL_SCOPE_KEY);
  if (keys.length > MAX_SCOPES) {
    keys
      .sort((a, b) => scopeTimestamp(file.scopes[a]!) - scopeTimestamp(file.scopes[b]!))
      .slice(0, keys.length - MAX_SCOPES)
      .forEach((key) => {
        delete file.scopes[key];
        changed = true;
      });
  }
  return changed;
}

function atomicWriteFile(file: LastInstancesFile): void {
  ensureConfigDir();
  const tmp = `${LAST_INSTANCE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LAST_INSTANCE_FILE);
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* SharedArrayBuffer unavailable; brief busy wait */
    }
  }
}

const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 15000;

function acquireLock(): number | null {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LAST_INSTANCE_LOCK, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {}
      return fd;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return null; // can't create lock (e.g. permissions); proceed best-effort
      }
      try {
        const stat = fs.statSync(LAST_INSTANCE_LOCK);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try {
            fs.unlinkSync(LAST_INSTANCE_LOCK);
          } catch {}
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat; retry immediately
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) return null;
      sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
}

function releaseLock(fd: number | null): void {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {}
  try {
    fs.unlinkSync(LAST_INSTANCE_LOCK);
  } catch {}
}

/**
 * Serialized, atomic read-modify-write of the last-instances file. The mutator
 * receives the parsed file plus the active scope key; returning `false` signals
 * no change so we can skip the write (and avoid needless lock churn for parallel
 * agents). Legacy data is migrated into the active scope before the mutator runs.
 */
function mutate(fn: (file: LastInstancesFile, scopeKey: string) => boolean | void): void {
  ensureConfigDir();
  const fd = acquireLock();
  try {
    const file = readNormalizedFile();
    const scopeKey = getScopeKey();
    let changed = foldLegacyInto(file, scopeKey);
    if (fn(file, scopeKey) !== false) changed = true;
    if (pruneScopes(file)) changed = true;
    if (changed) atomicWriteFile(file);
  } finally {
    releaseLock(fd);
  }
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

function isLastGradleInstance(value: unknown): value is LastGradleInstance {
  return isRecord(value) && value['type'] === 'gradle' && typeof value['id'] === 'string';
}

function detectLastInstanceType(instanceId: string): 'ios' | 'android' | 'xcode' | 'gradle' {
  const rawPrefix = instanceId.split('_')[0];
  if (rawPrefix === 'android') return 'android';
  if (rawPrefix === 'ios') return 'ios';
  if (rawPrefix === 'gradle') return 'gradle';
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

// Deliberately not a type predicate: GradleInstance is structurally identical
// to XcodeInstance, so excluding it from the union would collapse the
// remaining arms to never.
function isGradleInstance(instance: InstanceInput): boolean {
  return detectLastInstanceType(instance.metadata.id) === 'gradle';
}

export type InstanceInput = AndroidInstance | IosInstance | XcodeInstance | GradleInstance;

function buildLastInstanceRecord(
  instanceOrId: InstanceInput,
): LastAndroidInstance | LastIosInstance | LastXcodeInstance | LastGradleInstance {
  const id = instanceOrId.metadata.id;
  if (isGradleInstance(instanceOrId)) {
    const gradle = instanceOrId as GradleInstance;
    return {
      id,
      type: 'gradle',
      metadata: gradle.metadata,
      spec: gradle.spec,
      status: gradle.status,
      apiUrl: gradle.status.apiUrl,
      token: gradle.status.token,
    };
  }
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

function buildLastXcodeSlotRecord(instanceOrId: InstanceInput): LastIosInstance | LastXcodeInstance | null {
  const record = buildLastInstanceRecord(instanceOrId);
  if (record.type === 'xcode') {
    return record;
  }
  if (record.type !== 'ios' || !isIosInstance(instanceOrId)) {
    return null;
  }

  const sandboxXcodeUrl = instanceOrId.status.sandbox?.xcode?.url;
  const sandboxXcodeId = sandboxXcodeUrl ? xcodeSandboxIdFromUrl(sandboxXcodeUrl) : undefined;
  if (!sandboxXcodeUrl || !sandboxXcodeId) {
    return record;
  }

  const metadata: XcodeInstance.Metadata = {
    id: sandboxXcodeId,
    createdAt: instanceOrId.metadata.createdAt,
    organizationId: instanceOrId.metadata.organizationId,
  };
  if (instanceOrId.metadata.displayName) {
    metadata.displayName = instanceOrId.metadata.displayName;
  }

  const spec: XcodeInstance.Spec = {
    region: instanceOrId.spec.region,
    inactivityTimeout: instanceOrId.spec.inactivityTimeout,
  };
  if (instanceOrId.spec.hardTimeout) {
    spec.hardTimeout = instanceOrId.spec.hardTimeout;
  }

  return {
    id: sandboxXcodeId,
    type: 'xcode',
    metadata,
    spec,
    status: {
      state: instanceOrId.status.state,
      apiUrl: sandboxXcodeUrl,
      token: instanceOrId.status.token,
    },
    apiUrl: sandboxXcodeUrl,
    token: instanceOrId.status.token,
  };
}

function saveLastInstance(instanceOrId: InstanceInput, slot?: 'xcode'): void {
  const record = buildLastInstanceRecord(instanceOrId);
  mutate((file, scopeKey) => {
    const scope = ensureScope(file, scopeKey);
    if (slot === 'xcode') {
      const xcodeRecord = buildLastXcodeSlotRecord(instanceOrId);
      if (xcodeRecord) scope.xcode = xcodeRecord;
    } else if (record.type === 'android') {
      scope.android = record;
    } else if (record.type === 'ios') {
      scope.ios = record;
    } else if (record.type === 'gradle') {
      scope.gradle = record;
    } else {
      scope.xcode = record;
    }
    scope.lastUsedAt = new Date().toISOString();
  });
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
  return readScope(getScopeKey()).android ?? null;
}

export function loadLastIosInstance(): LastIosInstance | null {
  return readScope(getScopeKey()).ios ?? null;
}

export function loadLastXcodeInstance(): LastIosInstance | LastXcodeInstance | null {
  return readScope(getScopeKey()).xcode ?? null;
}

export function loadLastGradleInstance(): LastGradleInstance | null {
  return readScope(getScopeKey()).gradle ?? null;
}

function sandboxXcodeIdFromLastIosInstance(instance: LastIosInstance | undefined): string | undefined {
  const sandboxXcodeUrl = instance?.sandboxXcodeUrl ?? instance?.status?.sandbox?.xcode?.url;
  return sandboxXcodeUrl ? xcodeSandboxIdFromUrl(sandboxXcodeUrl) : undefined;
}

export function clearLastInstanceId(instanceId: string): void {
  mutate((file) => {
    let changed = false;
    for (const scope of Object.values(file.scopes)) {
      const iosRecord = scope.ios;
      for (const key of ['ios', 'android', 'xcode', 'gradle'] as const) {
        if (scope[key]?.id === instanceId) {
          delete scope[key];
          changed = true;
        }
      }
      const sandboxXcodeId =
        iosRecord?.id === instanceId ? sandboxXcodeIdFromLastIosInstance(iosRecord) : undefined;
      if (sandboxXcodeId && scope.xcode?.type === 'xcode' && scope.xcode.id === sandboxXcodeId) {
        delete scope.xcode;
        changed = true;
      }
    }
    return changed;
  });
}

export function saveInstanceCache(
  instanceId: string,
  data:
    | Partial<LastAndroidInstance>
    | Partial<LastIosInstance>
    | Partial<LastXcodeInstance>
    | Partial<LastGradleInstance>,
): void {
  mutate((file) => {
    let changed = false;
    for (const scope of Object.values(file.scopes)) {
      if (scope.android?.id === instanceId) {
        scope.android = {
          ...scope.android,
          ...(data as Partial<LastAndroidInstance>),
          type: 'android',
        };
        changed = true;
      }
      if (scope.ios?.id === instanceId) {
        scope.ios = {
          ...scope.ios,
          ...(data as Partial<LastIosInstance>),
          type: 'ios',
        };
        changed = true;
      }
      if (scope.xcode?.id === instanceId) {
        scope.xcode =
          scope.xcode.type === 'ios' ?
            { ...scope.xcode, ...(data as Partial<LastIosInstance>), type: 'ios' }
          : { ...scope.xcode, ...(data as Partial<LastXcodeInstance>), type: 'xcode' };
        changed = true;
      }
      if (scope.gradle?.id === instanceId) {
        scope.gradle = {
          ...scope.gradle,
          ...(data as Partial<LastGradleInstance>),
          type: 'gradle',
        };
        changed = true;
      }
    }
    return changed;
  });
}

export function loadAndroidInstanceCache(instanceId: string): LastAndroidInstance | null {
  for (const scope of Object.values(readNormalizedFile().scopes)) {
    if (scope.android?.id === instanceId) return scope.android;
  }
  return null;
}

export function loadIosInstanceCache(instanceId: string): LastIosInstance | null {
  for (const scope of Object.values(readNormalizedFile().scopes)) {
    if (scope.ios?.id === instanceId) return scope.ios;
    if (scope.xcode?.type === 'ios' && scope.xcode.id === instanceId) return scope.xcode;
  }
  return null;
}

export function loadXcodeInstanceCache(instanceId: string): LastXcodeInstance | null {
  for (const scope of Object.values(readNormalizedFile().scopes)) {
    if (scope.xcode?.type === 'xcode' && scope.xcode.id === instanceId) return scope.xcode;
  }
  return null;
}

export function loadGradleInstanceCache(instanceId: string): LastGradleInstance | null {
  for (const scope of Object.values(readNormalizedFile().scopes)) {
    if (scope.gradle?.id === instanceId) return scope.gradle;
  }
  return null;
}
