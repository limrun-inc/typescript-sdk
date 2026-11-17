import crypto from 'crypto';
import {
  type LastAndroidInstance,
  type LastGradleInstance,
  type LastIosInstance,
  type LastXcodeInstance,
} from './config';
import { type InstanceType } from './instance-client-factory';

export type ManualInstanceRecord =
  | LastAndroidInstance
  | LastIosInstance
  | LastXcodeInstance
  | LastGradleInstance;

const SIGNED_TOKEN_PREFIX = 'lim_st_';

// TID prefixes an instance of each type can carry. Xcode instances appear
// both standalone (xcode_) and as sandboxes nested in iOS instances (sandbox_).
const ID_PREFIXES: Record<InstanceType, string[]> = {
  ios: ['ios'],
  android: ['android'],
  xcode: ['xcode', 'sandbox'],
  gradle: ['gradle'],
};

/**
 * The instance id named by a signed token's scopes, if any. Signed tokens are
 * JWTs whose payload carries scopes shaped <resource>:<instance-tid>:<action>,
 * so the token itself tells which instance it opens. Decoded without
 * verification: the id is local bookkeeping, the router does the real check.
 * Legacy opaque tokens and wildcard scopes yield undefined.
 */
export function instanceIdFromToken(token: string, type: InstanceType): string | undefined {
  if (!token.startsWith(SIGNED_TOKEN_PREFIX)) return undefined;
  const parts = token.slice(SIGNED_TOKEN_PREFIX.length).split('.');
  if (parts.length !== 3) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const scopes = (payload as { scopes?: unknown }).scopes;
  if (!Array.isArray(scopes)) return undefined;
  for (const raw of scopes) {
    if (typeof raw !== 'string') continue;
    const segments = raw.split(':');
    if (segments.length !== 3) continue;
    const [resource, id] = segments;
    if (resource !== type || !id || id === '*') continue;
    if (ID_PREFIXES[type].some((prefix) => id.startsWith(`${prefix}_`))) return id;
  }
  return undefined;
}

/**
 * A deterministic local handle for an instance whose token names no id (legacy
 * opaque tokens, wildcard scopes). Hashing the apiUrl keeps re-runs idempotent:
 * the same instance maps to the same record and daemon session. The type
 * prefix keeps prefix-based dispatch (detectInstanceType) working.
 */
export function syntheticInstanceId(type: InstanceType, apiUrl: string): string {
  const hash = crypto.createHash('sha1').update(apiUrl).digest('hex').slice(0, 12);
  return `${type}_local_${hash}`;
}

export interface ManualInstanceInput {
  type: InstanceType;
  apiUrl: string;
  token: string;
  adbWebSocketUrl?: string;
}

/**
 * A last-instance record built from just apiUrl + token, the minimum needed
 * for direct instance control without a management API key.
 */
export function buildManualInstanceRecord(input: ManualInstanceInput): ManualInstanceRecord {
  const id = instanceIdFromToken(input.token, input.type) ?? syntheticInstanceId(input.type, input.apiUrl);
  switch (input.type) {
    case 'android':
      return {
        id,
        type: 'android',
        apiUrl: input.apiUrl,
        token: input.token,
        ...(input.adbWebSocketUrl ? { adbWebSocketUrl: input.adbWebSocketUrl } : {}),
      };
    case 'ios':
      return { id, type: 'ios', apiUrl: input.apiUrl, token: input.token };
    case 'xcode':
      return { id, type: 'xcode', apiUrl: input.apiUrl, token: input.token };
    case 'gradle':
      return { id, type: 'gradle', apiUrl: input.apiUrl, token: input.token };
  }
}

function envVarName(type: InstanceType, suffix: 'URL' | 'TOKEN' | 'ADB_URL'): string {
  return `LIM_${type.toUpperCase()}_INSTANCE_${suffix}`;
}

/**
 * The ambient target pinned by LIM_<TYPE>_INSTANCE_URL + LIM_<TYPE>_INSTANCE_TOKEN,
 * or null when either is missing. Built in memory and never persisted, so the
 * environment fully defines the target per process — a parent hands a sandboxed
 * agent two env vars and every command just works, no set-instance needed.
 */
export function envInstanceTarget(type: 'ios'): LastIosInstance | null;
export function envInstanceTarget(type: 'android'): LastAndroidInstance | null;
export function envInstanceTarget(type: 'xcode'): LastXcodeInstance | null;
export function envInstanceTarget(type: 'gradle'): LastGradleInstance | null;
export function envInstanceTarget(type: InstanceType): ManualInstanceRecord | null;
export function envInstanceTarget(type: InstanceType): ManualInstanceRecord | null {
  const apiUrl = process.env[envVarName(type, 'URL')]?.trim();
  const token = process.env[envVarName(type, 'TOKEN')]?.trim();
  if (!apiUrl || !token) return null;
  const adbWebSocketUrl = type === 'android' ? process.env[envVarName(type, 'ADB_URL')]?.trim() : undefined;
  return buildManualInstanceRecord({ type, apiUrl, token, ...(adbWebSocketUrl ? { adbWebSocketUrl } : {}) });
}
