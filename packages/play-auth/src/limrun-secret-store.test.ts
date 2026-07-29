import { describe, expect, it, vi } from 'vitest';
import { createLimrunSecretStore } from './limrun-secret-store';
import { ANDROID_SIGNING_KEY_SECRET_TYPE, putAndroidSigningKeySecret } from './secret-store';

function storeWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const store = createLimrunSecretStore({
    apiUrl: 'https://api.limrun.com/',
    token: 'limrun-token',
    organizationId: 'org/1',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { store, fetchMock };
}

describe('createLimrunSecretStore', () => {
  it('puts the keystore under the org secrets path with auth and replace', async () => {
    const { store, fetchMock } = storeWith(200, {
      id: 'sec_1',
      type: ANDROID_SIGNING_KEY_SECRET_TYPE,
      name: 'com.example.app',
      organizationId: 'org/1',
      data: { keystoreBase64: 'a2V5', keystorePassword: 'pw', keyAlias: 'upload', keyPassword: 'pw' },
      createdAt: '2026-07-29T00:00:00Z',
    });
    const secret = await putAndroidSigningKeySecret(store, 'com.example.app', {
      keystoreBase64: 'a2V5',
      keystorePassword: 'pw',
      keyAlias: 'upload',
      keyPassword: 'pw',
    });
    expect(secret.name).toBe('com.example.app');
    expect(secret.data.keystoreBase64).toBe('a2V5');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.limrun.com/v1/organizations/org%2F1/secrets/androidSigningKey/com.example.app',
    );
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer limrun-token');
    expect(JSON.parse(init.body as string)).toMatchObject({ replace: true });
  });

  it('returns undefined on 404 and surfaces backend error messages', async () => {
    const missing = storeWith(404, { message: 'not found' });
    await expect(missing.store.get(ANDROID_SIGNING_KEY_SECRET_TYPE, 'com.x')).resolves.toBeUndefined();
    const failing = storeWith(500, { message: 'db down' });
    await expect(failing.store.get(ANDROID_SIGNING_KEY_SECRET_TYPE, 'com.x')).rejects.toThrow(/db down/);
  });

  it('lists only androidSigningKey secrets, accepting both list body shapes', async () => {
    const secrets = [
      {
        id: 's1',
        type: ANDROID_SIGNING_KEY_SECRET_TYPE,
        name: 'com.x',
        organizationId: 'org/1',
        createdAt: 'c1',
      },
      {
        id: 's2',
        type: 'appleCertificate',
        name: 'TEAM/DISTRIBUTION',
        organizationId: 'org/1',
        createdAt: 'c2',
      },
    ];
    for (const body of [secrets, { secrets }]) {
      const { store } = storeWith(200, body);
      await expect(store.list()).resolves.toEqual([
        { type: ANDROID_SIGNING_KEY_SECRET_TYPE, name: 'com.x', createdAt: 'c1' },
      ]);
    }
  });

  it('treats deleting an absent secret as success', async () => {
    const { store } = storeWith(404, { message: 'not found' });
    await expect(store.delete(ANDROID_SIGNING_KEY_SECRET_TYPE, 'com.x')).resolves.toBeUndefined();
  });
});
