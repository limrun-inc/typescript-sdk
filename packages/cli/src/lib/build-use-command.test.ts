import { EventEmitter } from 'events';
import { NotFoundError } from '@limrun/api';
import { writeMiseTools } from '@limrun/api/mise-tools';
import { BaseCommand } from '../base-command';
import XcodeUse from '../commands/xcode/use';
import XcodeVersionSet from '../commands/xcode/version/set';
import GradleUse from '../commands/gradle/use';
import { loadXcodeVersionPreference, setXcodeVersionPreference } from './config';

jest.mock('@limrun/api/mise-tools', () => ({
  ...jest.requireActual('@limrun/api/mise-tools'),
  writeMiseTools: jest.fn(),
}));
jest.mock('./config', () => ({
  ...jest.requireActual('./config'),
  clearLastInstanceId: jest.fn(),
  loadXcodeVersionPreference: jest.fn(),
  setXcodeVersionPreference: jest.fn(),
}));
jest.mock('./daemon', () => ({ ...jest.requireActual('./daemon'), stopDaemon: jest.fn() }));

const target = { id: 'sandbox_euna_existing', type: 'xcode' };
const selection = { bound: { major: '27', version: '27.0', build: '27A5252f' }, derivedDataReset: true };

function setup(
  CommandClass: typeof BaseCommand = XcodeUse,
  argv = ['xcode@27'],
  flags: Record<string, unknown> = {},
) {
  const command = new (CommandClass as unknown as new (argv: string[], config: never) => BaseCommand)(
    [],
    {} as never,
  );
  const proc = Object.assign(Promise.resolve({ exitCode: 0 }), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const client = {
    setXcode: jest.fn().mockResolvedValue(selection),
    sync: jest.fn().mockResolvedValue({}),
    run: jest.fn().mockReturnValue(proc),
  };
  const resolveTarget = jest.fn().mockResolvedValue(target);
  const resolveBuild = jest.fn().mockResolvedValue({ client });
  const create = jest.fn();
  const output = jest.fn();
  const outputJson = jest.fn();
  Object.assign(command, {
    parse: async () => ({ flags: { cwd: '.', ...flags }, argv, args: { major: argv[0] } }),
    getCommandParts: () => ['xcode', CommandClass === XcodeVersionSet ? 'version' : 'use'],
    scopeSuffix: () => ' in this workspace',
    tryResolveXcodeTarget: resolveTarget,
    resolveXcodeClient: async () => client,
    resolveBuildToolClient: resolveBuild,
    createReplacementInstance: create,
    _lastResolvedInstanceId: target.id,
    info: jest.fn(),
    output,
    outputJson,
  });
  return { command, client, resolveTarget, resolveBuild, create, output, outputJson };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadXcodeVersionPreference).mockReturnValue('26');
  jest.mocked(writeMiseTools).mockResolvedValue(`${process.cwd()}/mise.toml`);
});

it.each([XcodeUse, XcodeVersionSet])(
  'shares Xcode selection and preference behavior',
  async (CommandClass) => {
    const { command, client, resolveTarget, resolveBuild, output } = setup(
      CommandClass,
      CommandClass === XcodeUse ? ['xcode@27'] : ['27'],
      { id: target.id },
    );
    await command.run();
    expect(resolveTarget).toHaveBeenCalledWith(target.id);
    expect(client.setXcode).toHaveBeenCalledWith('27');
    expect(setXcodeVersionPreference).toHaveBeenCalledWith('27');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('27.0 (27A5252f)'));
    expect(output).toHaveBeenCalledWith(expect.stringContaining('invalidated'));
    expect(writeMiseTools).not.toHaveBeenCalled();
    expect(resolveBuild).not.toHaveBeenCalled();
    expect(client.sync).not.toHaveBeenCalled();
    expect(client.run).not.toHaveBeenCalled();
  },
);

it('records Xcode without creating a sandbox when none is remembered', async () => {
  const { command, resolveTarget, client, resolveBuild, create, outputJson } = setup(XcodeUse, ['xcode@27'], {
    json: true,
  });
  resolveTarget.mockResolvedValue(undefined);
  await command.run();
  expect(setXcodeVersionPreference).toHaveBeenCalledWith('27');
  expect(outputJson).toHaveBeenCalledWith({ preferred: '27' });
  expect(client.setXcode).not.toHaveBeenCalled();
  expect(resolveBuild).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('returns the same JSON selection as version set', async () => {
  const { command, outputJson } = setup(XcodeUse, ['xcode@27'], { json: true });
  await command.run();
  expect(outputJson).toHaveBeenCalledWith({ instanceId: target.id, preferred: '27', ...selection });
});

it.each([
  [400, false],
  [409, true],
])('preserves refusal behavior for HTTP %i', async (status, recordsPreference) => {
  const { command, client } = setup();
  client.setXcode.mockRejectedValue(Object.assign(new Error('refused'), { status, body: 'refused' }));
  await expect(command.run()).rejects.toThrow('refused');
  expect(setXcodeVersionPreference).toHaveBeenCalledTimes(recordsPreference ? 1 : 0);
});

it('does not replace a missing sandbox during Xcode selection', async () => {
  const { command, client, create } = setup();
  client.setXcode.mockRejectedValue(new NotFoundError(404, { message: 'missing' }, undefined, new Headers()));
  await expect(command.run()).rejects.toThrow('was not found');
  expect(create).not.toHaveBeenCalled();
});

it('combines Xcode selection with mise tools without writing Xcode to TOML', async () => {
  const { command, client } = setup(XcodeUse, ['xcode@27', 'node@24.5.0', 'ruby@3.3.7']);
  await command.run();
  expect(setXcodeVersionPreference).toHaveBeenCalledWith('27');
  expect(writeMiseTools).toHaveBeenCalledWith(process.cwd(), { node: '24', ruby: '3.3' });
  expect(client.sync).toHaveBeenCalledTimes(1);
  expect(client.run).toHaveBeenCalledWith(expect.stringContaining("'node' 'ruby'"), { cwd: '.' });
  expect(client.run.mock.calls[0]![0]).not.toContain('xcode');
  expect(client.setXcode.mock.invocationCallOrder[0]).toBeLessThan(client.sync.mock.invocationCallOrder[0]!);
});

it.each(['xcode@27.1', 'xcode@latest', 'xcode@'])(
  'rejects invalid Xcode request %s before mutations',
  async (request) => {
    const { command, client } = setup(XcodeUse, ['node@24', request]);
    await expect(command.run()).rejects.toThrow('takes an Xcode major');
    expect(client.setXcode).not.toHaveBeenCalled();
    expect(setXcodeVersionPreference).not.toHaveBeenCalled();
    expect(writeMiseTools).not.toHaveBeenCalled();
  },
);

it.each([
  { argv: ['xcode@27', 'invalid'], flags: {} },
  { argv: ['xcode@27'], flags: { cwd: '..' } },
])('validates all requests and scope flags before switching Xcode', async ({ argv, flags }) => {
  const { command, client } = setup(XcodeUse, argv, flags);
  await expect(command.run()).rejects.toThrow();
  expect(client.setXcode).not.toHaveBeenCalled();
  expect(writeMiseTools).not.toHaveBeenCalled();
});

it('keeps Xcode out of Gradle tool selection', async () => {
  const { command, client } = setup(GradleUse);
  await expect(command.run()).rejects.toThrow('managed separately');
  expect(client.setXcode).not.toHaveBeenCalled();
  expect(writeMiseTools).not.toHaveBeenCalled();
});
