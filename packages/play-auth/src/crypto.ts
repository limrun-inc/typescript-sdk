import forge from 'node-forge';

const rsaSigningAlgorithm: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: 'SHA-256',
};

export async function generateRsaSigningKeyPair(): Promise<CryptoKeyPair> {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available in this browser.');
  }
  return crypto.subtle.generateKey(rsaSigningAlgorithm, true, ['sign', 'verify']);
}

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
