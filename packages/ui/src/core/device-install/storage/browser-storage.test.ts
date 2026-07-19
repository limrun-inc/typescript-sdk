import forge from 'node-forge';
import { describe, expect, test } from 'vitest';
import { normalizeCertificateSerial, parseProvisioningProfileBase64 } from './browser-storage';

function selfSignedCertificateBase64(serialNumber: string) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Apple Development Test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
}

function profileBase64(certificatesBase64: string[]) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Name</key><string>Limrun Dev</string>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>TeamIdentifier</key><array><string>TEAM123</string></array>
  <key>ProvisionedDevices</key><array><string>00008030-000A</string></array>
  <key>DeveloperCertificates</key>
  <array>${certificatesBase64.map((c) => `<data>${c}</data>`).join('')}</array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>TEAM123.com.example.app</string>
    <key>com.apple.developer.team-identifier</key><string>TEAM123</string>
  </dict>
</dict>
</plist>`;
  return btoa(xml);
}

describe('parseProvisioningProfileBase64', () => {
  test('extracts embedded certificate serial numbers in normalized form', () => {
    const parsed = parseProvisioningProfileBase64(
      profileBase64([selfSignedCertificateBase64('00ab12cd'), selfSignedCertificateBase64('7f')]),
    );
    expect(parsed.certificateSerialNumbers).toEqual(['AB12CD', '7F']);
    expect(parsed.bundleID).toBe('com.example.app');
    expect(parsed.teamID).toBe('TEAM123');
    expect(parsed.provisionedDevices).toEqual(['00008030-000A']);
  });

  test('skips unparseable certificates instead of failing the profile', () => {
    const parsed = parseProvisioningProfileBase64(
      profileBase64([btoa('not a certificate'), selfSignedCertificateBase64('1a')]),
    );
    expect(parsed.certificateSerialNumbers).toEqual(['1A']);
  });
});

describe('normalizeCertificateSerial', () => {
  test('uppercases and strips leading zeros', () => {
    expect(normalizeCertificateSerial('00ab12')).toBe('AB12');
    expect(normalizeCertificateSerial('AB12')).toBe('AB12');
    expect(normalizeCertificateSerial('')).toBeUndefined();
    expect(normalizeCertificateSerial(undefined)).toBeUndefined();
  });
});
