import { Hash, Mode, Srp, util } from '@foxt/js-srp';

export type AppleSRPProtocol = 's2k' | 's2k_fo';

export type AppleSRPInitRequest = {
  a: string;
  accountName: string;
  protocols: AppleSRPProtocol[];
};

export type AppleSRPInitResponse = {
  iteration: number;
  salt: string;
  protocol: AppleSRPProtocol;
  b: string;
  c: string;
};

export type AppleSRPCompleteProof = {
  accountName: string;
  m1: string;
  m2: string;
  c: string;
};

const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);

export class AppleGsaSrpClient {
  private srpClient?: Awaited<ReturnType<typeof srp.newClient>>;

  constructor(private readonly accountName: string) {}

  async init(): Promise<AppleSRPInitRequest> {
    if (this.srpClient) {
      throw new Error('SRP client is already initialized.');
    }
    this.srpClient = await srp.newClient(stringToBytes(this.accountName), new Uint8Array());
    return {
      accountName: this.accountName,
      protocols: ['s2k', 's2k_fo'],
      a: bytesToBase64(util.bytesFromBigint(this.srpClient.A)),
    };
  }

  async complete(password: string, serverData: AppleSRPInitResponse): Promise<AppleSRPCompleteProof> {
    if (!this.srpClient) {
      throw new Error('SRP client is not initialized.');
    }
    if (serverData.protocol !== 's2k' && serverData.protocol !== 's2k_fo') {
      throw new Error(`Unsupported Apple SRP protocol ${serverData.protocol}.`);
    }
    const salt = base64ToBytes(serverData.salt);
    const serverPublicKey = base64ToBytes(serverData.b);
    const derivedPassword = await deriveApplePassword(
      serverData.protocol,
      password,
      salt,
      serverData.iteration,
    );
    this.srpClient.p = derivedPassword;
    await this.srpClient.generate(salt, serverPublicKey);
    const m2 = await this.srpClient.generateM2();
    return {
      accountName: this.accountName,
      c: serverData.c,
      m1: bytesToBase64(this.srpClient._M),
      m2: bytesToBase64(m2),
    };
  }
}

async function deriveApplePassword(
  protocol: AppleSRPProtocol,
  password: string,
  salt: Uint8Array,
  iterations: number,
) {
  let passHash = new Uint8Array(await util.hash(srp.h, toArrayBuffer(stringToBytes(password))));
  if (protocol === 's2k_fo') {
    passHash = stringToBytes(util.toHex(passHash));
  }
  const imported = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(passHash),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: { name: 'SHA-256' },
      iterations,
      salt: toArrayBuffer(salt),
    },
    imported,
    256,
  );
  return new Uint8Array(derived);
}

function stringToBytes(value: string) {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
