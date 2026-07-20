import forge from 'node-forge';

import { generateAndroidSigningKey } from './android-keystore';

describe('generateAndroidSigningKey', () => {
  // One shared key: RSA generation dominates test time.
  const key = generateAndroidSigningKey('com.example.app');

  it('produces the exact androidSigningKey secret data shape', () => {
    expect(Object.keys(key).sort()).toEqual([
      'keyAlias',
      'keyPassword',
      'keystoreBase64',
      'keystorePassword',
    ]);
    expect(key.keyAlias).toBe('upload');
    expect(key.keystorePassword).toBe(key.keyPassword);
    expect(key.keystorePassword).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('builds a PKCS12 that opens with the emitted password and holds a long-lived RSA-2048 key', () => {
    const der = forge.util.decode64(key.keystoreBase64);
    expect(der.length).toBeGreaterThan(0);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), key.keystorePassword);

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ];
    expect(keyBags).toHaveLength(1);
    expect(keyBags![0].attributes.friendlyName?.[0]).toBe('upload');
    const privateKey = keyBags![0].key as forge.pki.rsa.PrivateKey;
    expect(privateKey.n.bitLength()).toBe(2048);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    expect(certBags).toHaveLength(1);
    const cert = certBags![0].cert!;
    // Play requires upload certificates valid well past 2033.
    expect(cert.validity.notAfter.getFullYear()).toBeGreaterThan(2034);
    expect(cert.subject.getField('CN').value).toBe('com.example.app');
  });

  it('rejects the wrong password', () => {
    const der = forge.util.decode64(key.keystoreBase64);
    expect(() => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), 'wrong-password')).toThrow();
  });
});
