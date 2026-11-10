import { Parser } from '@oclif/core';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SecretCreate from './create';
import SecretGet from './get';
import SecretUpdate from './update';
import SecretDelete from './delete';
import SecretRead from './read';
import SecretWrite from './write';
import { secretBytes, secretMetadata, secretTarget } from '../../lib/secret-input';

function setup(
  command:
    | typeof SecretCreate
    | typeof SecretGet
    | typeof SecretUpdate
    | typeof SecretDelete
    | typeof SecretRead
    | typeof SecretWrite,
  args: Record<string, string> = {},
  flags: Record<string, unknown> = {},
) {
  const value = { id: 'secret_test', name: 'npm/token', metadata: {} };
  const secrets = {
    create: jest.fn().mockResolvedValue(value),
    get: jest.fn().mockResolvedValue(value),
    update: jest.fn().mockResolvedValue(value),
    delete: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ secrets: [value] }),
    read: jest.fn().mockResolvedValue(new Uint8Array([0, 255, 10])),
    write: jest.fn().mockResolvedValue(undefined),
  };
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ args, flags: { json: true, ...flags } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    outputResult: jest.fn(),
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(instance, 'client', { value: { secrets } });
  return { instance, secrets };
}

test('metadata commands never call value access methods', async () => {
  for (const command of [SecretCreate, SecretGet, SecretUpdate, SecretDelete]) {
    const { instance, secrets } = setup(
      command,
      { name: 'npm/token', target: 'npm/token' },
      { type: 'generic', metadata: '{"registry":"npm"}' },
    );
    await instance.run();
    expect(secrets.read).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
    if (command === SecretCreate)
      expect(secrets.create).toHaveBeenCalledWith({
        name: 'npm/token',
        type: 'generic',
        metadata: { registry: 'npm' },
      });
    if (command === SecretUpdate)
      expect(secrets.update).toHaveBeenCalledWith('name/npm/token', { metadata: { registry: 'npm' } });
  }
});

test('write takes its value argument by default and does not echo it', async () => {
  const { instance, secrets } = setup(SecretWrite, { target: 'npm/token', value: 'private-value' });
  let received: Buffer | undefined;
  secrets.write.mockImplementation(async (_target, bytes) => {
    received = Buffer.from(bytes);
  });
  await instance.run();
  expect(received!.toString()).toBe('private-value');
  expect(JSON.stringify(instance.outputResult.mock.calls)).not.toContain('private-value');
  expect(secrets.write.mock.calls[0][1].every((byte: number) => byte === 0)).toBe(true);
});

test.each([
  [{ target: 'npm/token' }, {}],
  [{ target: 'npm/token', value: 'secret' }, { file: '/tmp/input' }],
  [{ target: 'npm/token', value: 'secret' }, { stdin: true }],
])('write requires exactly one input source', async (args, flags) => {
  const { instance, secrets } = setup(SecretWrite, args, flags);
  await expect(instance.run()).rejects.toThrow('exactly one');
  expect(secrets.write).not.toHaveBeenCalled();
});

test('file writes preserve bytes, enforce the size limit, and read output is private without overwrite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lim-secret-test-'));
  try {
    const input = join(dir, 'input');
    const output = join(dir, 'output');
    writeFileSync(input, Buffer.from([0, 255, 10]));
    const write = setup(SecretWrite, { target: 'npm/token' }, { file: input });
    let received: Buffer | undefined;
    write.secrets.write.mockImplementation(async (_target, bytes) => {
      received = Buffer.from(bytes);
    });
    await write.instance.run();
    expect(received).toEqual(Buffer.from([0, 255, 10]));
    const read = setup(SecretRead, { target: 'npm/token' }, { output });
    await read.instance.run();
    expect(readFileSync(output)).toEqual(Buffer.from([0, 255, 10]));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    await expect(read.instance.run()).rejects.toThrow('EEXIST');
    writeFileSync(input, Buffer.alloc(65537));
    await expect(secretBytes(input)).rejects.toThrow('64 KiB');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON reads are explicitly base64 and preserve binary values', async () => {
  const { instance } = setup(SecretRead, { target: 'npm/token' });
  await instance.run();
  expect(instance.outputJson).toHaveBeenCalledWith({ encoding: 'base64', data: 'AP8K' });
});

test('names are literal and metadata must be a bounded object', () => {
  expect(secretTarget('npm/token')).toBe('name/npm/token');
  expect(secretTarget('name/npm/token')).toBe('name/npm/token');
  expect(() => secretTarget('npm/*')).toThrow();
  for (const value of ['[]', 'null', 'invalid', JSON.stringify({ text: 'x'.repeat(16384) })])
    expect(() => secretMetadata(value)).toThrow();
});

test.each(['', 'x'.repeat(65537)])(
  'write rejects invalid argument sizes before authentication',
  async (value) => {
    const { instance, secrets } = setup(SecretWrite, { target: 'npm/token', value });
    instance.withAuth = jest.fn();
    await expect(instance.run()).rejects.toThrow('64 KiB');
    expect(instance.withAuth).not.toHaveBeenCalled();
    expect(secrets.write).not.toHaveBeenCalled();
  },
);

test.each([['--stdin'], ['--file', '-']])(
  'parser leaves piped values for the explicit input handler: %s',
  async (...inputFlags) => {
    const globals = globalThis as typeof globalThis & { oclif?: { stdinCache?: string } };
    const original = globals.oclif;
    globals.oclif = { ...original, stdinCache: '  private-value\n' };
    try {
      const parsed = await Parser.parse(['npm/token', ...inputFlags], {
        args: SecretWrite.args,
        flags: SecretWrite.flags,
      });
      expect(parsed.args.target).toBe('npm/token');
      expect(parsed.args.value).toBeUndefined();
    } finally {
      globals.oclif = original;
    }
  },
);
