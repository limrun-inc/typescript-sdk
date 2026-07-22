// Browser-side Android upload keystore generation, the Play twin of the
// Apple certificate flow: the private key is born in the browser and goes
// only into the caller's SigningSecretStore; Limrun never sees it. The
// recipe mirrors the lim CLI's server-side generator
// (packages/cli/src/lib/android-keystore.ts, keep the two in sync): RSA-2048,
// self-signed certificate valid ~27 years (Google Play requires upload
// keys to stay valid well past 2033), packaged as a JDK-compatible
// PKCS12. Store and key password share one value, which PKCS12 under
// Java effectively requires.
import forge from 'node-forge';
import { generateRsaSigningKeyPair, toPkcs12Base64 } from '../crypto';

export type AndroidUploadKeystore = {
  keystoreBase64: string;
  keystorePassword: string;
  keyAlias: string;
  keyPassword: string;
};

const VALIDITY_DAYS = 10_000;
const KEY_ALIAS = 'upload';

// Alphanumeric only: the values end up in gradle.properties, which Gradle
// reads as ISO-8859-1, and must survive any shell quoting users apply.
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generatePassword(length = 24): string {
  // Rejection sampling: 2^32 is not a multiple of 62, so a plain modulo
  // would overweight the first four alphabet characters (immeasurably,
  // but unbiased is three lines and matches the CLI twin's randomInt).
  const limit = Math.floor(0x100000000 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let out = '';
  const batch = new Uint32Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(batch);
    for (const value of batch) {
      if (value < limit) {
        out += PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

/**
 * Generates a fresh Android upload keystore for the given application ID.
 * WebCrypto performs the expensive key generation; forge assembles the
 * self-signed certificate (including one pure-JS RSA signature over it)
 * and the PKCS12, mirroring the Apple crypto in this package.
 */
export async function generateAndroidUploadKeystore(applicationId: string): Promise<AndroidUploadKeystore> {
  const password = generatePassword();
  const keyPair = await generateRsaSigningKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const privateKey = forge.pki.privateKeyFromAsn1(
    forge.asn1.fromDer(forge.util.createBuffer(pkcs8).getBytes()),
  ) as forge.pki.rsa.PrivateKey;
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  certificate.setSubject([
    { name: 'commonName', value: applicationId },
    { name: 'organizationName', value: 'Limrun' },
  ]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(privateKey, forge.md.sha256.create());

  return {
    keystoreBase64: toPkcs12Base64(privateKey, [certificate], password, KEY_ALIAS),
    keystorePassword: password,
    keyAlias: KEY_ALIAS,
    keyPassword: password,
  };
}
