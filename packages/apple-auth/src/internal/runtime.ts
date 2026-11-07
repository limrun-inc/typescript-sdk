export async function runtimeCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto;
  if (typeof process !== 'undefined' && process.versions?.node) {
    return (await import('node:crypto')).webcrypto as unknown as Crypto;
  }
  throw new Error('Web Crypto requires a secure browser context or Node.js 18 or later.');
}
