import type { InstallSource } from './operations';

export interface DeviceSession {
  id: string;
  webSocketUrl: string;
  token: string;
  expiresAt: string;
}

export interface CreateDeviceSessionOptions {
  registryApiUrl: string;
  token?: string;
  organizationId?: string;
  operation: 'pair' | 'install';
  installSource?: InstallSource;
  idempotencyKey?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

/** Creates a worker and waits until its WebSocket route is ready. */
export async function createDeviceSession({
  registryApiUrl,
  token,
  organizationId,
  operation,
  installSource,
  idempotencyKey = globalThis.crypto.randomUUID(),
  signal,
  fetch: fetchImplementation = globalThis.fetch,
}: CreateDeviceSessionOptions): Promise<DeviceSession> {
  const url = new URL(registryApiUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ios/device/sessions`;
  url.search = '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (organizationId) headers['X-Limrun-Organization'] = organizationId;
  // Retry transport failures once with the same key: the first response may have been lost.
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchImplementation(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation, ...installSource }),
        signal,
      });
      break;
    } catch (error) {
      if (attempt === 1 || signal?.aborted) throw error;
    }
  }
  if (!response) throw new Error('Device session creation failed');
  const body = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(body?.message ?? `Device session creation failed (HTTP ${response.status})`);
  if (
    typeof body?.id !== 'string' ||
    typeof body?.token !== 'string' ||
    typeof body?.webSocketUrl !== 'string' ||
    typeof body?.expiresAt !== 'string'
  ) {
    throw new Error('Invalid device session response');
  }
  return body as DeviceSession;
}

export function sessionWebSocketUrl(session: DeviceSession): string {
  const url = new URL(session.webSocketUrl);
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:')
    throw new Error('Invalid device session WebSocket URL');
  url.searchParams.set('token', session.token);
  return url.toString();
}
