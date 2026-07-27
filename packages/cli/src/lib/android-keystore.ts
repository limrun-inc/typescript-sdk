// Keep in sync with the browser twin in
// packages/ui/src/core/play-publish/keystore.ts: both generators feed the
// same androidSigningKey secret shape, so recipe drift is a correctness
// hazard, not a style one.
import { generateKeyPairSync, randomInt } from 'node:crypto';

import forge from 'node-forge';

export type AndroidSigningKey = {
  keystoreBase64: string;
  keystorePassword: string;
  keyAlias: string;
  keyPassword: string;
};

// Google Play requires upload-key certificates to stay valid well past
// 2033; ~27 years matches what Android Studio generates.
const validityDays = 10_000;
const keyAlias = 'upload';

// Alphanumeric only: the values end up in gradle.properties, which Gradle
// reads as ISO-8859-1, and must survive any shell quoting users apply.
const passwordAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generatePassword(length = 24): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += passwordAlphabet[randomInt(passwordAlphabet.length)];
  }
  return out;
}

/**
 * Generates an Android upload keystore entirely in JS: a local JDK cannot
 * be assumed since builds run remotely. The output is a PKCS12 the JDK's
 * dual-format keystore reader auto-detects; 3DES encryption keeps it
 * readable by every Java version. Store and key password are the same
 * value, which PKCS12 under Java effectively requires.
 */
export function generateAndroidSigningKey(applicationId: string): AndroidSigningKey {
  const password = generatePassword();
  // Native keygen (hundreds of ms) instead of node-forge's pure-JS one
  // (many seconds of silent event-loop blocking); forge only assembles
  // the certificate and PKCS12, mirroring the ui package's apple crypto.
  const { privateKey: privateKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);
  certificate.setSubject([
    { name: 'commonName', value: applicationId },
    { name: 'organizationName', value: 'Limrun' },
  ]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, {
    algorithm: '3des',
    friendlyName: keyAlias,
  });
  const keystoreBase64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes());

  return {
    keystoreBase64,
    keystorePassword: password,
    keyAlias,
    keyPassword: password,
  };
}
