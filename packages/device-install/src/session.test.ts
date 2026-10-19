import { describe, expect, it, vi } from 'vitest';
import { createDeviceSession, sessionWebSocketUrl } from './session';

const session = {
  id: 'device-session-1',
  webSocketUrl: 'wss://node.example/v1/device-session-1/api/ws',
  token: 'session-only',
  expiresAt: '2026-10-19T18:00:00Z',
};

describe('device sessions', () => {
  it('authorizes creation with the caller token and connects with only the session token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(session, { status: 201 }));
    const result = await createDeviceSession({
      registryApiUrl: 'https://registry.example',
      token: 'broad-api-key',
      organizationId: 'org_1',
      operation: 'install',
      installSource: { assetId: 'asset_1' },
      idempotencyKey: 'request-123',
      fetch,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe('https://registry.example/ios/device/sessions');
    expect(init.headers.Authorization).toBe('Bearer broad-api-key');
    expect(init.headers['X-Limrun-Organization']).toBe('org_1');
    expect(JSON.parse(init.body)).toEqual({ operation: 'install', assetId: 'asset_1' });
    expect(sessionWebSocketUrl(result)).toBe(`${session.webSocketUrl}?token=session-only`);
    expect(sessionWebSocketUrl(result)).not.toContain('broad-api-key');
  });

  it('retries a lost response with the same idempotency key', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(Response.json(session));
    await createDeviceSession({
      registryApiUrl: 'https://registry.example',
      operation: 'pair',
      idempotencyKey: 'retry-123',
      fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe(
      fetch.mock.calls[1]![1].headers['Idempotency-Key'],
    );
  });

  it('returns authorization failures without retrying or opening a relay', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ message: 'asset not allowed' }, { status: 403 }));
    await expect(
      createDeviceSession({
        registryApiUrl: 'https://registry.example',
        operation: 'install',
        idempotencyKey: 'denied-123',
        fetch,
      }),
    ).rejects.toThrow('asset not allowed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
