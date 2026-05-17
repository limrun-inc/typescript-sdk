import forge from 'node-forge';

export type AppleSigningKeyMaterial = {
  privateKey: CryptoKey;
  privateKeyPKCS8Base64: string;
  publicKeySPKIBase64: string;
  csrPEM: string;
  csrBase64: string;
};

export type AppleCSRInput = {
  commonName: string;
  emailAddress?: string;
};

export type ExportP12Input = {
  privateKeyPKCS8Base64: string;
  certificateBase64?: string;
  certificatePEM?: string;
  password: string;
  friendlyName?: string;
};

const rsaAlgorithm: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: 'SHA-256',
};

export async function generateAppleSigningKeyAndCSR(input: AppleCSRInput): Promise<AppleSigningKeyMaterial> {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available in this browser.');
  }
  const keyPair = await crypto.subtle.generateKey(rsaAlgorithm, true, ['sign', 'verify']);
  const publicKeySPKI = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const certificationRequestInfo = derSequence(
    derInteger(0),
    derName(input),
    publicKeySPKI,
    derContext(0, new Uint8Array()),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, toArrayBuffer(certificationRequestInfo)),
  );
  const csrDER = derSequence(
    certificationRequestInfo,
    derSequence(derOID('1.2.840.113549.1.1.11'), derNull()),
    derBitString(signature),
  );
  const privateKeyPKCS8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    privateKey: keyPair.privateKey,
    privateKeyPKCS8Base64: bytesToBase64(privateKeyPKCS8),
    publicKeySPKIBase64: bytesToBase64(publicKeySPKI),
    csrPEM: pemBlock('CERTIFICATE REQUEST', csrDER),
    csrBase64: bytesToBase64(csrDER),
  };
}

export function exportAppleCertificateP12(input: ExportP12Input) {
  if (!input.certificateBase64 && !input.certificatePEM) {
    throw new Error('certificateBase64 or certificatePEM is required.');
  }
  const privateKey = forge.pki.privateKeyFromPem(
    pemFromBase64('PRIVATE KEY', input.privateKeyPKCS8Base64),
  );
  const certificate = input.certificatePEM
    ? forge.pki.certificateFromPem(input.certificatePEM)
    : forge.pki.certificateFromAsn1(
        forge.asn1.fromDer(forge.util.createBuffer(base64ToBinary(input.certificateBase64!))),
      );
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], input.password, {
    algorithm: '3des',
    friendlyName: input.friendlyName,
  });
  const der = forge.asn1.toDer(p12).getBytes();
  return binaryToBase64(der);
}

function derName(input: AppleCSRInput) {
  const attributes = [derAttribute('2.5.4.3', derUTF8String(input.commonName))];
  if (input.emailAddress) {
    attributes.push(derAttribute('1.2.840.113549.1.9.1', derIA5String(input.emailAddress)));
  }
  return derSequence(...attributes);
}

function derAttribute(oid: string, value: Uint8Array) {
  return derSet(derSequence(derOID(oid), value));
}

function derSequence(...values: Uint8Array[]) {
  return derTLV(0x30, concatBytes(...values));
}

function derSet(...values: Uint8Array[]) {
  return derTLV(0x31, concatBytes(...values));
}

function derContext(tag: number, value: Uint8Array) {
  return derTLV(0xa0 + tag, value);
}

function derInteger(value: number) {
  return derTLV(0x02, new Uint8Array([value]));
}

function derNull() {
  return new Uint8Array([0x05, 0x00]);
}

function derUTF8String(value: string) {
  return derTLV(0x0c, new TextEncoder().encode(value));
}

function derIA5String(value: string) {
  return derTLV(0x16, new TextEncoder().encode(value));
}

function derBitString(value: Uint8Array) {
  return derTLV(0x03, concatBytes(new Uint8Array([0]), value));
}

function derOID(oid: string) {
  const parts = oid.split('.').map((part) => parseInt(part, 10));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  const encoded = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    encoded.push(...stack);
  }
  return derTLV(0x06, new Uint8Array(encoded));
}

function derTLV(tag: number, value: Uint8Array) {
  return concatBytes(new Uint8Array([tag]), derLength(value.byteLength), value);
}

function derLength(length: number) {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function pemBlock(label: string, der: Uint8Array) {
  const base64 = bytesToBase64(der);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemFromBase64(label: string, base64: string) {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function binaryToBase64(binary: string) {
  return btoa(binary);
}

function base64ToBinary(value: string) {
  return atob(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
