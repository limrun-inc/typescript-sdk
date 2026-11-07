import { beforeAll, expect, test } from 'vitest';
import forge from 'node-forge';
import { exportAppleCertificateP12, generateAppleSigningKeyAndCSR } from './crypto';

let privateKeyPKCS8Base64: string;
let certificatePEM: string;
beforeAll(async () => {
  const material = await generateAppleSigningKeyAndCSR({ commonName: 'P12 export test' });
  privateKeyPKCS8Base64 = material.privateKeyPKCS8Base64;
  const csr = forge.pki.certificationRequestFromPem(material.csrPEM);
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.decode64(privateKeyPKCS8Base64)));
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + 86400000);
  certificate.setSubject(csr.subject.attributes);
  certificate.setIssuer(csr.subject.attributes);
  certificate.sign(key, forge.md.sha256.create());
  certificatePEM = forge.pki.certificateToPem(certificate);
});

test.each([undefined, '', 'Signing certificate'])(
  'exports a readable P12 with friendly name %j',
  (friendlyName) => {
    const encoded = exportAppleCertificateP12({
      privateKeyPKCS8Base64,
      certificatePEM,
      password: 'test-password',
      friendlyName,
    });
    const p12 = forge.pkcs12.pkcs12FromAsn1(
      forge.asn1.fromDer(forge.util.decode64(encoded)),
      'test-password',
    );
    const key = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag!
    ]![0]!.key!;
    const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag!]![0]!.cert!;
    expect(key.n.toString(16)).toBe((cert.publicKey as forge.pki.rsa.PublicKey).n.toString(16));
    if (friendlyName !== undefined) {
      expect(p12.getBags({ friendlyName }).friendlyName).toHaveLength(2);
    }
  },
);
