// Thin wrapper around the example backend. The backend holds your Limrun API
// key and provisions an Xcode build sandbox, then hands the browser a per
// instance `apiUrl` + `token` (safe to expose — it can only touch this one
// sandbox). See examples/device-install/backend.
import type { Sandbox } from '../types';

const BACKEND_URL = 'http://localhost:3000';

export async function createSandbox(): Promise<Sandbox> {
  const response = await fetch(`${BACKEND_URL}/create-sandbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webSessionId: `web-${Date.now()}` }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Failed to create sandbox');
  return { id: data.id, apiUrl: data.apiUrl, token: data.token };
}

export async function stopSandbox(sandboxId: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/stop-sandbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sandboxId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Failed to stop sandbox');
}
