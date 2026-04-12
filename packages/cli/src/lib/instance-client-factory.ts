import Limrun, { createInstanceClient, Ios, type InstanceClient } from '@limrun/api';
import { isSessionActive, sendCommand } from './daemon-client';
import { loadState } from './daemon';

export type InstanceType = 'android' | 'ios' | 'xcode';

export interface ResolvedInstanceClient {
  type: InstanceType;
  client: InstanceClient | Ios.InstanceClient;
  disconnect: () => void;
  /** True if the client is backed by a daemon session (don't disconnect). */
  isSession: boolean;
}

export function detectInstanceType(id: string): InstanceType {
  const prefix = id.split('_')[0];
  if (prefix === 'android') return 'android';
  if (prefix === 'ios') return 'ios';
  if (prefix === 'xcode') return 'xcode';
  throw new Error(`Cannot detect instance type from ID "${id}". Expected prefix "android_", "ios_", or "xcode_".`);
}

/**
 * Check if a daemon session is active for the given instance ID.
 * If yes, exec commands should use sendCommand() instead.
 */
export function hasActiveSession(id: string): boolean {
  if (!isSessionActive()) return false;
  const state = loadState();
  return state?.instanceId === id;
}

/**
 * Send a command via the daemon session. Used by exec commands when a session is active.
 */
export { sendCommand } from './daemon-client';

/**
 * Create a direct instance client (no daemon). Used when no session is active.
 */
export async function getInstanceClient(lim: Limrun, id: string): Promise<ResolvedInstanceClient> {
  const type = detectInstanceType(id);

  if (type === 'android') {
    const instance = await lim.androidInstances.get(id);
    const apiUrl = instance.status.apiUrl;
    const token = instance.status.token;
    if (!apiUrl) {
      throw new Error(`Android instance ${id} does not have an apiUrl. Is it ready?`);
    }
    const client = await createInstanceClient({
      apiUrl,
      adbUrl: instance.status.adbWebSocketUrl,
      token,
    });
    return { type, client, disconnect: () => client.disconnect(), isSession: false };
  }

  const instance = await lim.iosInstances.get(id);
  const apiUrl = instance.status.apiUrl;
  const token = instance.status.token;
  if (!apiUrl) {
    throw new Error(`iOS instance ${id} does not have an apiUrl. Is it ready?`);
  }
  const client = await Ios.createInstanceClient({ apiUrl, token });
  return { type, client, disconnect: () => client.disconnect(), isSession: false };
}
