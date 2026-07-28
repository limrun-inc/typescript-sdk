// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import {
  downloadAppStoreConnectApiKeyPrivateKey,
  listAppStoreConnectVendorNumbers,
} from './app-store-connect';

describe('App Store Connect API key download', () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----\n';

  function relayServing(privateKey: string) {
    return {
      request: vi.fn().mockResolvedValue({
        status: 200,
        body: { data: { type: 'apiKeys', id: 'KEY1', attributes: { privateKey } } },
      }),
    };
  }

  // Apple serves the privateKey attribute as base64 of the .p8 PEM text.
  // Storing it re-encoded once more used to double-encode the key, which
  // limbuild rejected with "not a valid EC private key".
  test('decodes the base64-encoded PEM Apple actually serves', async () => {
    const relay = relayServing(btoa(PEM));
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).resolves.toMatchObject({
      privateKeyPem: PEM,
    });
  });

  test('passes through a key already in PEM form', async () => {
    const relay = relayServing(PEM);
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).resolves.toMatchObject({
      privateKeyPem: PEM,
    });
  });

  test('rejects unrecognizable private key payloads', async () => {
    const relay = relayServing(btoa('not a pem at all'));
    await expect(downloadAppStoreConnectApiKeyPrivateKey({ relay, keyId: 'KEY1' })).rejects.toThrow(
      'unrecognized format',
    );
  });
});

describe('App Store Connect vendor number lookup', () => {
  function relayServing(data: unknown) {
    return { request: vi.fn().mockResolvedValue({ status: 200, body: { data } }) };
  }

  test('hits the payments endpoint of the given provider', async () => {
    const relay = relayServing([{ sapVendorNumber: 85912345 }]);
    await expect(listAppStoreConnectVendorNumbers({ relay, providerId: 121234567 })).resolves.toEqual([
      '85912345',
    ]);
    expect(relay.request).toHaveBeenCalledWith('appstoreconnect', {
      path: '/WebObjects/iTunesConnect.woa/ra/paymentConsolidation/providers/121234567/sapVendorNumbers',
    });
  });

  test('resolves the provider from the session when none is given', async () => {
    const request = vi.fn(async (type: string) => {
      if (type === 'finalize') {
        return { status: 200, body: { provider: { providerId: 121234567 } } };
      }
      return { status: 200, body: { data: [{ vendorNumber: '85912345' }] } };
    });
    await expect(listAppStoreConnectVendorNumbers({ relay: { request } })).resolves.toEqual(['85912345']);
    expect(request).toHaveBeenCalledWith('appstoreconnect', {
      path: '/WebObjects/iTunesConnect.woa/ra/paymentConsolidation/providers/121234567/sapVendorNumbers',
    });
  });

  test('rejects when the session has no active provider', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, body: {} });
    await expect(listAppStoreConnectVendorNumbers({ relay: { request } })).rejects.toThrow(
      'no active provider',
    );
  });

  test('tolerates payload shape variations and drops non-numeric values', async () => {
    const cases: Array<[unknown, string[]]> = [
      [
        [{ sapVendorNumber: 85912345 }, { sapVendorNumber: 87754321 }],
        ['85912345', '87754321'],
      ],
      [{ sapVendorNumber: '85912345' }, ['85912345']],
      [['85912345', 85912345], ['85912345']],
      [[{ vendorId: '85912345' }, { name: 'no vendor number here' }], ['85912345']],
      [[{ sapVendorNumber: 'N/A' }], []],
      [undefined, []],
    ];
    for (const [data, expected] of cases) {
      const relay = relayServing(data);
      await expect(listAppStoreConnectVendorNumbers({ relay, providerId: '1' })).resolves.toEqual(expected);
    }
  });
});
