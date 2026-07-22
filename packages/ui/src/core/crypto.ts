// Shared browser-crypto building blocks for the credential flows: the
// Apple CSR path and the Android upload-keystore path use the same key
// profile and the same PKCS12 packaging, so the profile lives in one
// place and cannot drift between them.
import forge from 'node-forge';

/** RSA-2048 with SHA-256, the signing profile every credential flow here uses. */
export const rsaSigningAlgorithm: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: 'SHA-256',
};

/** Generates an extractable RSA signing key pair via WebCrypto. */
export async function generateRsaSigningKeyPair(): Promise<CryptoKeyPair> {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available in this browser.');
  }
  return crypto.subtle.generateKey(rsaSigningAlgorithm, true, ['sign', 'verify']);
}

/**
 * Assembles a PKCS12 from a key and its certificates and returns it
 * base64-encoded. 3DES encryption keeps it readable by every Java
 * version (the JDK's dual-format keystore reader auto-detects PKCS12).
 */
export function toPkcs12Base64(
  privateKey: forge.pki.rsa.PrivateKey,
  certificates: forge.pki.Certificate[],
  password: string,
  friendlyName?: string,
): string {
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, certificates, password, {
    algorithm: '3des',
    friendlyName,
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}
