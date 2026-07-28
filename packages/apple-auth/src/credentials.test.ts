// @vitest-environment node

import forge from 'node-forge';
import { describe, expect, test } from 'vitest';
import type { AppleRelayWebSocketClient } from './relay';
import {
  APP_STORE_CONNECT_API_KEY_SECRET_TYPE,
  APPLE_CERTIFICATE_SECRET_TYPE,
  appleCertificateSecretName,
  appStoreConnectApiKeySecretName,
  ensureAppleCertificateSecret,
  ensureAppStoreConnectApiKeySecret,
  type SigningSecret,
  type SigningSecretMetadata,
  type SigningSecretStore,
  type SigningSecretType,
} from './index';

/**
 * A self-signed certificate is enough for exportAppleCertificateP12: the
 * p12 bundling never verifies that the key matches the certificate.
 */
function selfSignedCertificateBase64() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Apple Development Test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
}

function memorySecretStore(options: { failPuts?: () => boolean } = {}) {
  const entries = new Map<string, SigningSecret>();
  const store: SigningSecretStore = {
    async put(type: SigningSecretType, name: string, data: Record<string, string>) {
      if (options.failPuts?.()) {
        throw new Error('secret store unavailable');
      }
      const secret: SigningSecret = { type, name, data, createdAt: new Date().toISOString() };
      entries.set(`${type}:${name}`, secret);
      return secret;
    },
    async get(type: SigningSecretType, name: string) {
      return entries.get(`${type}:${name}`);
    },
    async list() {
      return [...entries.values()].map(({ data: _data, ...metadata }): SigningSecretMetadata => metadata);
    },
    async delete(type: SigningSecretType, name: string) {
      entries.delete(`${type}:${name}`);
    },
  };
  return { store, entries };
}

type PortalState = { mintedCertificateIds: string[]; certificateBase64: string };

/**
 * Fakes the relay's provisioning proxy: minting appends to
 * mintedCertificateIds, listing reflects what has been minted so far.
 */
function fakePortalRelay(state: PortalState): AppleRelayWebSocketClient {
  return {
    async request(_type: string, payload: unknown) {
      const request = payload as { path: string };
      if (request.path.includes('listCertRequests')) {
        return portalOK({
          certRequests: state.mintedCertificateIds.map((certificateId) => ({ certificateId })),
        });
      }
      if (request.path.includes('submitCertificateRequest')) {
        const certificateId = `CERT${state.mintedCertificateIds.length + 1}`;
        state.mintedCertificateIds.push(certificateId);
        return portalOK({
          certRequest: {
            certificateId,
            serialNum: '01',
            expirationDateString: '2027-01-01',
          },
        });
      }
      if (request.path.includes('downloadCertificateContent')) {
        return { status: 200, statusText: 'OK', rawBodyBase64: state.certificateBase64 };
      }
      throw new Error(`unexpected portal path: ${request.path}`);
    },
  } as unknown as AppleRelayWebSocketClient;
}

function portalOK(body: Record<string, unknown>) {
  return { status: 200, statusText: 'OK', body: { resultCode: 0, ...body } };
}

describe('ensureAppleCertificateSecret', () => {
  const teamId = 'TEAM1';
  const secretName = appleCertificateSecretName(teamId, 'DEVELOPMENT');

  test('surfaces an actionable error when the store write fails after minting', async () => {
    const state: PortalState = {
      mintedCertificateIds: [],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const broken = memorySecretStore({ failPuts: () => true });

    await expect(
      ensureAppleCertificateSecret({
        relay: fakePortalRelay(state),
        teamId,
        secretStore: broken.store,
      }),
    ).rejects.toThrow(/revoke certificate CERT1/);
    expect(state.mintedCertificateIds).toEqual(['CERT1']);
  });

  test('mints and stores the certificate with its type in the secret name', async () => {
    const state: PortalState = {
      mintedCertificateIds: [],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const org = memorySecretStore();

    const result = await ensureAppleCertificateSecret({
      relay: fakePortalRelay(state),
      teamId,
      secretStore: org.store,
    });
    expect(result.created).toBe(true);
    expect(result.certificateId).toBe('CERT1');
    const stored = await org.store.get(APPLE_CERTIFICATE_SECRET_TYPE, secretName);
    expect(stored?.data.certificateID).toBe('CERT1');
    expect(stored?.data.certificateType).toBe('DEVELOPMENT');
    expect(stored?.data.certificateP12Base64).toBeTruthy();
  });

  test('mints distribution certificates under their own secret name', async () => {
    const state: PortalState = {
      mintedCertificateIds: [],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const org = memorySecretStore();

    const result = await ensureAppleCertificateSecret({
      relay: fakePortalRelay(state),
      teamId,
      secretStore: org.store,
      certificateKind: 'distribution',
    });
    expect(result.created).toBe(true);
    const stored = await org.store.get(
      APPLE_CERTIFICATE_SECRET_TYPE,
      appleCertificateSecretName(teamId, 'DISTRIBUTION'),
    );
    expect(stored?.data.certificateType).toBe('DISTRIBUTION');
    expect(stored?.data.certificateP12Base64).toBeTruthy();
  });

  test('reuses the stored certificate when it is still on the team', async () => {
    const state: PortalState = {
      mintedCertificateIds: ['CERT1'],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const org = memorySecretStore();
    await org.store.put(APPLE_CERTIFICATE_SECRET_TYPE, secretName, {
      certificateP12Base64: 'cDEy',
      certificateID: 'CERT1',
      teamID: teamId,
    });

    const result = await ensureAppleCertificateSecret({
      relay: fakePortalRelay(state),
      teamId,
      secretStore: org.store,
    });
    expect(result.created).toBe(false);
    expect(result.certificateId).toBe('CERT1');
    expect(state.mintedCertificateIds).toEqual(['CERT1']);
  });
});

/**
 * Fakes the relay's App Store Connect proxy for a team holding one active
 * API key KEY1 and, unless vendorNumbersFail, one vendor number.
 */
function fakeAppStoreConnectRelay(options: { vendorNumbersFail?: boolean } = {}) {
  return {
    async request(type: string, payload: unknown) {
      if (type === 'finalize') {
        return {
          status: 200,
          statusText: 'OK',
          body: { provider: { providerId: 121234567, publicProviderId: 'PUB-UUID' } },
        };
      }
      const request = payload as { path: string };
      if (request.path === '/iris/v1/apiKeys') {
        return {
          status: 200,
          statusText: 'OK',
          body: { data: [{ type: 'apiKeys', id: 'KEY1', attributes: { isActive: true } }] },
        };
      }
      if (request.path.endsWith('/sapVendorNumbers')) {
        if (options.vendorNumbersFail) {
          return { status: 403, statusText: 'Forbidden', body: {} };
        }
        return { status: 200, statusText: 'OK', body: { data: [{ sapVendorNumber: 85912345 }] } };
      }
      throw new Error(`unexpected App Store Connect path: ${request.path}`);
    },
  } as unknown as AppleRelayWebSocketClient;
}

describe('ensureAppStoreConnectApiKeySecret', () => {
  const teamId = 'TEAM1';
  const secretName = appStoreConnectApiKeySecretName(teamId);
  const storedKeyData = {
    privateKeyP8Base64: 'cDg=',
    keyId: 'KEY1',
    issuerId: 'ISSUER',
    teamID: teamId,
  };

  test('backfills the vendor number into a reused key secret', async () => {
    const org = memorySecretStore();
    await org.store.put(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName, storedKeyData);

    const result = await ensureAppStoreConnectApiKeySecret({
      relay: fakeAppStoreConnectRelay(),
      teamId,
      secretStore: org.store,
      nickname: 'Test Publishing',
    });
    expect(result.created).toBe(false);
    expect(result.keyId).toBe('KEY1');
    const stored = await org.store.get(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName);
    expect(stored?.data.vendorNumber).toBe('85912345');
    expect(stored?.data.issuerId).toBe('ISSUER');
  });

  test('still reuses the key when the vendor number lookup fails', async () => {
    const org = memorySecretStore();
    await org.store.put(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName, storedKeyData);

    const result = await ensureAppStoreConnectApiKeySecret({
      relay: fakeAppStoreConnectRelay({ vendorNumbersFail: true }),
      teamId,
      secretStore: org.store,
      nickname: 'Test Publishing',
    });
    expect(result.created).toBe(false);
    expect(result.keyId).toBe('KEY1');
    const stored = await org.store.get(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName);
    expect(stored?.data.vendorNumber).toBeUndefined();
  });

  test('leaves a complete stored key secret untouched', async () => {
    const org = memorySecretStore();
    await org.store.put(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName, {
      ...storedKeyData,
      vendorNumber: '87754321',
    });

    const result = await ensureAppStoreConnectApiKeySecret({
      relay: fakeAppStoreConnectRelay(),
      teamId,
      secretStore: org.store,
      nickname: 'Test Publishing',
    });
    expect(result.created).toBe(false);
    const stored = await org.store.get(APP_STORE_CONNECT_API_KEY_SECRET_TYPE, secretName);
    expect(stored?.data.vendorNumber).toBe('87754321');
  });
});
