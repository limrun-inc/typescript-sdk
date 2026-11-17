import { Parser } from '@oclif/core';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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
    parse: async () => ({ args, flags: { json: true, metadata: '{}', type: 'generic', ...flags } }),
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

test('create saves its optional value by the new ID without echoing it', async () => {
  const { instance, secrets } = setup(SecretCreate, { name: 'npm/token', value: 'private-value' });
  let received: Buffer | undefined;
  secrets.write.mockImplementation(async (_target, bytes) => {
    received = Buffer.from(bytes);
  });
  await instance.run();
  expect(received!.toString()).toBe('private-value');
  expect(secrets.write.mock.calls[0][0]).toBe('secret_test');
  expect(secrets.create.mock.invocationCallOrder[0]).toBeLessThan(secrets.write.mock.invocationCallOrder[0]);
  expect(JSON.stringify(instance.outputResult.mock.calls)).not.toContain('private-value');
  expect(secrets.write.mock.calls[0][1]).toEqual(Buffer.alloc(13));
});

test('create preserves file bytes and validates input before creating a container', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lim-secret-create-'));
  try {
    const file = join(dir, 'input');
    const input = Buffer.from([0, 255, 10]);
    writeFileSync(file, input);
    const { instance, secrets } = setup(SecretCreate, { name: 'npm/config' }, { file });
    let received: Buffer | undefined;
    secrets.write.mockImplementation(async (_target, bytes) => {
      received = Buffer.from(bytes);
    });
    await instance.run();
    expect(received).toEqual(input);
    expect(secrets.write.mock.calls[0][1]).toEqual(Buffer.alloc(3));
    for (const invalid of [Buffer.alloc(0), Buffer.alloc(65537)]) {
      writeFileSync(file, invalid);
      const invalidCreate = setup(SecretCreate, { name: 'npm/config' }, { file });
      await expect(invalidCreate.instance.run()).rejects.toThrow();
      expect(invalidCreate.secrets.create).not.toHaveBeenCalled();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [{ name: 'npm/token', value: '' }, {}],
  [{ name: 'npm/token', value: 'x'.repeat(65537) }, {}],
  [{ name: 'npm/token', value: 'secret' }, { file: '/tmp/input' }],
  [{ name: 'npm/token', value: 'secret' }, { stdin: true }],
  [{ name: 'npm/token' }, { file: '/tmp/input', stdin: true }],
])('create rejects invalid or ambiguous input before authentication', async (args, flags) => {
  const { instance, secrets } = setup(SecretCreate, args, flags);
  instance.withAuth = jest.fn();
  await expect(instance.run()).rejects.toThrow();
  expect(instance.withAuth).not.toHaveBeenCalled();
  expect(secrets.create).not.toHaveBeenCalled();
});

test('create conflicts never write a value to an existing secret', async () => {
  const { instance, secrets } = setup(SecretCreate, { name: 'npm/token', value: 'private-value' });
  secrets.create.mockRejectedValue(new Error('Conflict'));
  await expect(instance.run()).rejects.toThrow('Conflict');
  expect(secrets.write).not.toHaveBeenCalled();
});

test('a failed initial write identifies the created container and clears its buffer', async () => {
  const { instance, secrets } = setup(SecretCreate, { name: 'npm/token', value: 'private-value' });
  secrets.write.mockRejectedValue(new Error('provider error containing private-value'));
  await expect(instance.run()).rejects.toThrow('lim secret write secret_test --stdin');
  expect(secrets.create).toHaveBeenCalledTimes(1);
  expect(secrets.delete).not.toHaveBeenCalled();
  expect(secrets.write.mock.calls[0][1]).toEqual(Buffer.alloc(13));
  expect(instance.outputResult).not.toHaveBeenCalled();
});

test.each([[], ['--stdin'], ['--file', '-']])(
  'create parser leaves stdin for the explicit value handler: %s',
  async (...inputFlags) => {
    const globals = globalThis as typeof globalThis & { oclif?: { stdinCache?: string } };
    const original = globals.oclif;
    globals.oclif = { ...original, stdinCache: '  private-value\n' };
    try {
      const parsed = await Parser.parse(['npm/token', ...inputFlags], {
        args: SecretCreate.args,
        flags: SecretCreate.flags,
      });
      expect(parsed.args.name).toBe('npm/token');
      expect(parsed.args.value).toBeUndefined();
    } finally {
      globals.oclif = original;
    }
  },
);

test.each([{ stdin: true }, { file: '-' }])('create reads exact stdin bytes with %o', async (flags) => {
  const input = Buffer.from('  private-value\n');
  const stream = Readable.from([input]);
  const stdin = jest.spyOn(process, 'stdin', 'get').mockReturnValue(stream as typeof process.stdin);
  try {
    const { instance, secrets } = setup(SecretCreate, { name: 'npm/token' }, flags);
    let received: Buffer | undefined;
    secrets.write.mockImplementation(async (_target, bytes) => {
      received = Buffer.from(bytes);
    });
    await instance.run();
    expect(received).toEqual(input);
    expect(secrets.write.mock.calls[0][1]).toEqual(Buffer.alloc(input.length));
  } finally {
    stdin.mockRestore();
  }
});
