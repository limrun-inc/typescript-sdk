import Limrun, { createInstanceClient, Ios, type InstanceClient } from '@limrun/api';
import { isSessionActive, sendCommand } from './daemon-client';
import { saveInstanceCache, type LastAndroidInstance, type LastIosInstance } from './config';

export type InstanceType = 'android' | 'ios' | 'xcode';

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
  throw new Error(
    `Cannot detect instance type from ID "${id}". Expected prefix "android_", "ios_", "xcode_", or "sandbox_".`,
  );
}

/**
 * Check if a daemon session is active for the given instance ID.
 */
export function hasActiveSession(id: string): boolean {
  return isSessionActive(id);
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
): Promise<ResolvedAndroidInstanceClient> {
  if (target.apiUrl && target.token) {
    const client = await createInstanceClient({
      apiUrl: target.apiUrl,
      adbUrl: target.adbWebSocketUrl,
      token: target.token,
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
