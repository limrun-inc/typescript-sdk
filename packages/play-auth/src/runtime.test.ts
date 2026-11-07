// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import forge from 'node-forge';
import { generateAndroidUploadKeystore } from './keystore';

afterEach(() => vi.unstubAllGlobals());

test('keystore generation uses Node crypto without installing browser globals', async () => {
  vi.stubGlobal('crypto', undefined);
  const key = await generateAndroidUploadKeystore('com.example.runtime');
  const asn1 = forge.asn1.fromDer(forge.util.decode64(key.keystoreBase64));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, key.keystorePassword);
  expect(p12.safeContents.length).toBeGreaterThan(0);
  expect(key.keyPassword).toBe(key.keystorePassword);
  expect(globalThis.crypto).toBeUndefined();
});
