// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { Hash, Mode, Srp, util } from './index';
import vectors from './gsa-vectors.json';

afterEach(() => vi.unstubAllGlobals());

test.each(vectors)('matches upstream GSA proofs for $identity', async (vector) => {
  vi.stubGlobal('crypto', undefined);
  const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);
  const client = await srp.newClient(
    new TextEncoder().encode(vector.identity),
    util.fromHex(vector.password),
    BigInt(`0x${vector.a}`),
  );
  expect(util.toHex(util.bytesFromBigint(client.A))).toBe(vector.A);
  await client.generate(util.fromHex(vector.salt), util.fromHex(vector.B));
  expect(util.toHex(client.K)).toBe(vector.K);
  expect(util.toHex(client.M)).toBe(vector.M1);
  expect(util.toHex(await client.generateM2())).toBe(vector.M2);
  expect(globalThis.crypto).toBeUndefined();
});

test('rejects a server public key equal to zero modulo the group prime', async () => {
  const srp = new Srp(Mode.GSA, Hash.SHA256, 2048);
  const client = await srp.newClient(new TextEncoder().encode('test@example.com'), new Uint8Array([1]));
  await expect(client.generate(new Uint8Array([1]), new Uint8Array([0]))).rejects.toThrow(
    'Invalid server public key',
  );
  await expect(client.generate(new Uint8Array([1]), util.bytesFromBigint(srp.pf.N))).rejects.toThrow(
    'Invalid server public key',
  );
});
