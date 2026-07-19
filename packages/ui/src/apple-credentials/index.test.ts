// @vitest-environment node

import forge from 'node-forge';
import { describe, expect, test } from 'vitest';
import type { AppleRelayWebSocketClient } from '../core/device-install/apple';
import {
  APPLE_CERTIFICATE_SECRET_TYPE,
  ensureAppleCertificateSecret,
  withRetries,
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

  test('failed store write parks the key locally and a retry recovers it without minting again', async () => {
    const state: PortalState = {
      mintedCertificateIds: [],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const relay = fakePortalRelay(state);
    const fallback = memorySecretStore();
    const broken = memorySecretStore({ failPuts: () => true });

    await expect(
      ensureAppleCertificateSecret({
        relay,
        teamId,
        secretStore: broken.store,
        localFallbackStore: fallback.store,
        storeAttempts: 2,
      }),
    ).rejects.toThrow(/kept safely in this browser/);

    // Exactly one certificate was minted and its p12 survived the failure.
    expect(state.mintedCertificateIds).toEqual(['CERT1']);
    const parked = await fallback.store.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId);
    expect(parked?.data.certificateID).toBe('CERT1');
    expect(parked?.data.certificateP12Base64).toBeTruthy();

    // Once the store works again the parked key is promoted, not re-minted.
    const working = memorySecretStore();
    const result = await ensureAppleCertificateSecret({
      relay,
      teamId,
      secretStore: working.store,
      localFallbackStore: fallback.store,
      storeAttempts: 2,
    });
    expect(state.mintedCertificateIds).toEqual(['CERT1']);
    expect(result.recovered).toBe(true);
    expect(result.created).toBe(false);
    expect(result.certificateId).toBe('CERT1');
    expect(result.secret.data.certificateP12Base64).toBe(parked?.data.certificateP12Base64);
    // The parked copy is cleaned up after promotion.
    expect(await fallback.store.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId)).toBeUndefined();
  });

  test('mints, parks, stores and cleans up the parked copy on success', async () => {
    const state: PortalState = {
      mintedCertificateIds: [],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const fallback = memorySecretStore();
    const org = memorySecretStore();

    const result = await ensureAppleCertificateSecret({
      relay: fakePortalRelay(state),
      teamId,
      secretStore: org.store,
      localFallbackStore: fallback.store,
    });
    expect(result.created).toBe(true);
    expect(result.certificateId).toBe('CERT1');
    expect((await org.store.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId))?.data.certificateID).toBe('CERT1');
    expect(await fallback.store.get(APPLE_CERTIFICATE_SECRET_TYPE, teamId)).toBeUndefined();
  });

  test('reuses the stored certificate when it is still on the team', async () => {
    const state: PortalState = {
      mintedCertificateIds: ['CERT1'],
      certificateBase64: selfSignedCertificateBase64(),
    };
    const org = memorySecretStore();
    await org.store.put(APPLE_CERTIFICATE_SECRET_TYPE, teamId, {
      certificateP12Base64: 'cDEy',
      certificateID: 'CERT1',
      teamID: teamId,
    });

    const result = await ensureAppleCertificateSecret({
      relay: fakePortalRelay(state),
      teamId,
      secretStore: org.store,
      localFallbackStore: memorySecretStore().store,
    });
    expect(result.created).toBe(false);
    expect(result.recovered).toBe(false);
    expect(result.certificateId).toBe('CERT1');
    expect(state.mintedCertificateIds).toEqual(['CERT1']);
  });
});

describe('withRetries', () => {
  test('returns after a transient failure and reports attempts', async () => {
    const attempts: number[] = [];
    let calls = 0;
    const value = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 3, initialDelayMs: 1, onAttempt: (attempt) => attempts.push(attempt) },
    );
    expect(value).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
  });

  test('throws the last error when all attempts fail', async () => {
    await expect(
      withRetries(
        async () => {
          throw new Error('permanent');
        },
        { attempts: 2, initialDelayMs: 1 },
      ),
    ).rejects.toThrow('permanent');
  });
});
