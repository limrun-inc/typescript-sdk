import { randomBytes } from 'crypto';

export function generateKeychainEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

export async function resolveKeychainEncryptionKey(options: {
  encryptionKey?: string;
  encryptionKeyStdin?: boolean;
}): Promise<string> {
  if (options.encryptionKey && options.encryptionKeyStdin) {
    throw new Error('Use either --encryption-key or --encryption-key-stdin, not both.');
  }
  if (options.encryptionKey) {
    const key = options.encryptionKey.trim();
    validateKeychainEncryptionKey(key);
    return key;
  }
  if (options.encryptionKeyStdin) {
    return readKeychainEncryptionKeyFromStdin();
  }
  throw new Error('Provide --encryption-key or --encryption-key-stdin.');
}

export async function readKeychainEncryptionKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('Provide a 32-byte base64 key on stdin.');
  }

  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const key = chunks.join('').trim();
  validateKeychainEncryptionKey(key);
  return key;
}

export function validateKeychainEncryptionKey(key: string): void {
  if (!key) {
    throw new Error('Keychain encryption key is empty.');
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(key)) {
    throw new Error('Keychain encryption key must be base64 or base64url.');
  }

  let normalized = key.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  normalized += '='.repeat(padding);
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== 32) {
    throw new Error('Keychain encryption key must decode to exactly 32 bytes.');
  }
}
