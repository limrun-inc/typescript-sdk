import { describe, expect, it, vi } from 'vitest';

import { createOTAInstallSession, getOTAInstallStatus } from './ota';

describe('OTA installation API', () => {
  it('creates a session with bearer and organization authentication', async () => {
    const payload = {
      id: 'session_1',
      installPageUrl: 'https://registry.example/ios/ota/install?session=signed',
      statusUrl: 'https://registry.example/ios/ota/status?session=signed',
      expiresAt: '2026-07-25T12:00:00Z',
    };
    const fetch = vi.fn(async () => Response.json(payload, { status: 201 }));
    const result = await createOTAInstallSession({
      registryApiUrl: 'https://registry.example/base/',
      token: 'scoped-token',
      organizationId: 'org_1',
      assetId: 'asset_1',
      bundleIdentifier: 'com.example.app',
      shortVersion: '1.2.3',
      buildVersion: '42',
      title: 'Example',
      ttlSeconds: 900,
      fetch,
    });

    expect(result).toEqual(payload);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://registry.example/base/ios/ota/sessions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer scoped-token',
      'X-Limrun-Organization': 'org_1',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      assetId: 'asset_1',
      bundleIdentifier: 'com.example.app',
      shortVersion: '1.2.3',
      buildVersion: '42',
      title: 'Example',
      ttlSeconds: 900,
    });
  });

  it('creates a session with just the asset id, deferring identity to asset metadata', async () => {
    const payload = {
      id: 'session_2',
      installPageUrl: 'https://registry.example/ios/ota/sessions/session_2?k=signed',
      statusUrl: 'https://registry.example/ios/ota/sessions/session_2/status?k=signed',
      expiresAt: '2026-07-25T12:00:00Z',
    };
    const fetch = vi.fn(async () => Response.json(payload, { status: 201 }));
    await createOTAInstallSession({
      registryApiUrl: 'https://registry.example',
      token: 'scoped-token',
      assetId: 'asset_1',
      deepLink: 'myapp://home',
      fetch,
    });
    const [, init] = fetch.mock.calls[0]!;
    // Omitted fields must stay out of the body so the registry falls back to
    // the metadata limbuild recorded on the asset.
    expect(JSON.parse(String(init.body))).toEqual({
      assetId: 'asset_1',
      deepLink: 'myapp://home',
    });
  });

  it('fetches status from the sticky capability URL without bearer credentials', async () => {
    const payload = {
      id: 'session_1',
      state: 'downloading',
      bytesTransferred: 50,
      totalBytes: 100,
      progress: 0.5,
      expiresAt: '2026-07-25T12:00:00Z',
    };
    const fetch = vi.fn(async () => Response.json(payload));
    await expect(
      getOTAInstallStatus({
        statusUrl: 'https://registry.example/ios/ota/status?session=signed',
        fetch,
      }),
    ).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith(
      'https://registry.example/ios/ota/status?session=signed',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('returns registry API errors', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ message: 'asset scope does not cover the requested asset' }, { status: 403 }),
    );
    await expect(
      createOTAInstallSession({
        registryApiUrl: 'https://registry.example',
        token: 'token',
        assetId: 'asset_2',
        bundleIdentifier: 'com.example.app',
        shortVersion: '1.0',
        buildVersion: '1',
        title: 'Example',
        fetch,
      }),
    ).rejects.toThrow('asset scope does not cover the requested asset');
  });
});
