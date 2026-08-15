import Limrun, { createInstanceClient, Ios, type InstanceClient } from '@limrun/api';
import { isSessionActive, sendCommand } from './daemon-client';
import { spawnSessionDaemon } from './daemon';
import { saveInstanceCache, type LastAndroidInstance, type LastIosInstance } from './config';

export type InstanceType = 'android' | 'ios' | 'xcode' | 'gradle';

export interface ResolvedAndroidInstanceClient {
  type: 'android';
  client: InstanceClient;
  disconnect: () => void;
  /** True if the client is backed by a daemon session (don't disconnect). */
  isSession: boolean;
}

export interface ResolvedIosInstanceClient {
  type: 'ios';
  client: Ios.InstanceClient;
  disconnect: () => void;
  /** True if the client is backed by a daemon session (don't disconnect). */
  isSession: boolean;
}

export function detectInstanceType(id: string): InstanceType {
  const prefix = id.split('_')[0];
  if (prefix === 'android') return 'android';
  if (prefix === 'ios') return 'ios';
  if (prefix === 'xcode' || prefix === 'sandbox') return 'xcode';
  if (prefix === 'gradle') return 'gradle';
  throw new Error(
    `Cannot detect instance type from ID "${id}". Expected prefix "android_", "ios_", "xcode_", "sandbox_", or "gradle_".`,
  );
}

let sessionAutoStart = { enabled: true, silent: false };

/** Configure daemon auto-start for this invocation; wired from the --daemon and --json flags. */
export function setSessionAutoStart(config: { enabled: boolean; silent?: boolean }): void {
  sessionAutoStart = { enabled: config.enabled, silent: config.silent ?? false };
}

/** Injectable for tests. */
type SpawnFn = typeof spawnSessionDaemon;

/**
 * Ensure a daemon session exists for the target so the command can use the
 * ~50ms Unix-socket path, starting one if needed. Returns false when the
 * command should fall back to a direct WebSocket instead: auto-start disabled,
 * credentials not known yet (the direct path fetches and caches them, so the
 * next command auto-starts), or the daemon failed to start.
 */
export async function ensureDaemonSession(
  target: LastAndroidInstance | LastIosInstance,
  spawnFn: SpawnFn = spawnSessionDaemon,
): Promise<boolean> {
  if (isSessionActive(target.id)) return true;
  if (!sessionAutoStart.enabled) return false;
  if (!target.apiUrl || !target.token) return false;

  try {
    await spawnFn({
      instanceId: target.id,
      instanceType: target.type,
      apiUrl: target.apiUrl,
      adbUrl: target.type === 'android' ? target.adbWebSocketUrl : undefined,
      token: target.token,
    });
  } catch (err) {
    if (!sessionAutoStart.silent) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Could not start WebSocket daemon for ${target.id} (${message}); connecting directly.`);
    }
    return false;
  }

  if (!sessionAutoStart.silent) {
    console.error(`WebSocket daemon started for ${target.id}.`);
  }
  return true;
}

/**
 * Send a command via the daemon session for the given instance ID.
 */
export function sendSessionCommand(
  instanceId: string,
  command: string,
  args: unknown[] = [],
  timeoutMs?: number,
): Promise<unknown> {
  return sendCommand(instanceId, command, args, timeoutMs);
}

export async function getAndroidInstanceClient(
  lim: Limrun,
  target: LastAndroidInstance,
  options: { adbPath?: string } = {},
): Promise<ResolvedAndroidInstanceClient> {
  if (target.apiUrl && target.token) {
    const client = await createInstanceClient({
      apiUrl: target.apiUrl,
      adbUrl: target.adbWebSocketUrl,
      token: target.token,
      adbPath: options.adbPath,
    });
    return { type: 'android', client, disconnect: () => client.disconnect(), isSession: false };
  }

  const instance = await lim.androidInstances.get(target.id);
  const apiUrl = instance.status.apiUrl;
  const token = instance.status.token;
  if (!apiUrl) {
    throw new Error(`Android instance ${target.id} does not have an apiUrl. Is it ready?`);
  }
  saveInstanceCache(instance.metadata.id, {
    apiUrl,
    adbWebSocketUrl: instance.status.adbWebSocketUrl,
    token,
    endpointWebSocketUrl: instance.status.endpointWebSocketUrl,
    mcpUrl: instance.status.mcpUrl,
    signedStreamUrl: instance.status.signedStreamUrl,
    targetHttpPortUrlPrefix: instance.status.targetHttpPortUrlPrefix,
  });
  const client = await createInstanceClient({
    apiUrl,
    adbUrl: instance.status.adbWebSocketUrl,
    token,
    adbPath: options.adbPath,
  });
  return { type: 'android', client, disconnect: () => client.disconnect(), isSession: false };
}

export async function getIosInstanceClient(
  lim: Limrun,
  target: LastIosInstance,
): Promise<ResolvedIosInstanceClient> {
  if (target.apiUrl && target.token) {
    const client = await Ios.createInstanceClient({ apiUrl: target.apiUrl, token: target.token });
    return { type: 'ios', client, disconnect: () => client.disconnect(), isSession: false };
  }

  const instance = await lim.iosInstances.get(target.id);
  const apiUrl = instance.status.apiUrl;
  const token = instance.status.token;
  if (!apiUrl) {
    throw new Error(`iOS instance ${target.id} does not have an apiUrl. Is it ready?`);
  }
  saveInstanceCache(instance.metadata.id, {
    apiUrl,
    token,
    endpointWebSocketUrl: instance.status.endpointWebSocketUrl,
    mcpUrl: instance.status.mcpUrl,
    signedStreamUrl: instance.status.signedStreamUrl,
    targetHttpPortUrlPrefix: instance.status.targetHttpPortUrlPrefix,
    sandboxXcodeUrl: instance.status.sandbox?.xcode?.url,
  });
  const client = await Ios.createInstanceClient({ apiUrl, token });
  return { type: 'ios', client, disconnect: () => client.disconnect(), isSession: false };
}
