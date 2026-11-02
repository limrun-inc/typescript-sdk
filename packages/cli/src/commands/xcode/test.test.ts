import { Parser } from '@oclif/core';
import XcodeTest from './test';
import { loadLastXcodeInstance } from '../../lib/config';

jest.mock('../../lib/config', () => ({
  ...jest.requireActual('../../lib/config'),
  loadLastXcodeInstance: jest.fn(),
  registerCreatedInstance: jest.fn(),
}));
jest.mock('../../lib/set-instance', () => ({ envInstanceTarget: () => undefined }));

const parse = (argv: string[]) => Parser.parse(argv, { flags: XcodeTest.flags });

const commandWith = (parsed: object, withAuth: jest.Mock) =>
  Object.assign(Object.create(XcodeTest.prototype), {
    parse: async () => ({ ...parsed, args: {} }),
    setParsedFlags: jest.fn(),
    withAuth,
    error: (message: string) => {
      throw new Error(message);
    },
  });

test.each([
  { argv: ['--model', 'ipad', '--id', 'sandbox_euna_test'] },
  { argv: ['--os-version', '27', '--build-only'] },
  { argv: ['--model', 'ipad', '--no-create'] },
])('rejects device selection for a run that creates no simulator: $argv', async ({ argv }) => {
  const withAuth = jest.fn();
  const command = commandWith(await parse(argv), withAuth);
  await expect(command.run()).rejects.toThrow(/cannot be combined with --id, --build-only or --no-create/);
  expect(withAuth).not.toHaveBeenCalled();
});

test('--model and --os-version become the spec of the simulator the run creates', async () => {
  const stop = new Error('stop before creating instances');
  const command = commandWith(
    await parse(['--model', 'ipad', '--os-version', '27']),
    jest.fn().mockRejectedValue(stop),
  );
  await expect(command.run()).rejects.toThrow(stop);
  expect(command.autoCreateSimulator).toEqual({
    model: 'ipad',
    clues: [{ kind: 'OSVersion', osVersion: '27' }],
  });
});

test('a chosen simulator skips the recorded target and attaches a simulator of that model and version', async () => {
  const recorded = { id: 'sandbox_euna_recorded', type: 'xcode' as const };
  const created = { id: 'sandbox_euna_new', type: 'xcode' as const };
  jest.mocked(loadLastXcodeInstance).mockReturnValueOnce(recorded as never);
  const getSimulator = jest.fn();
  const attachNewSimulator = jest.fn().mockResolvedValue({ simulator: { metadata: { id: 'ios_euna_new' } } });
  const cmd = new XcodeTest([], {} as never);
  Object.assign(cmd, {
    autoCreateSimulator: { model: 'ipad', clues: [{ kind: 'OSVersion', osVersion: '27' }] },
    shouldAutoCreateOnNotFound: () => true,
    createStandaloneXcodeInstance: async () => created,
    resolveXcodeClient: async () => ({ getSimulator, attachNewSimulator }),
    info: jest.fn(),
  });
  const resolve = cmd as unknown as {
    resolveSimulatorBackedXcodeTargetOrCreate(id?: string): Promise<{ id: string }>;
  };

  await expect(resolve.resolveSimulatorBackedXcodeTargetOrCreate(undefined)).resolves.toMatchObject({
    id: created.id,
  });
  expect(getSimulator).not.toHaveBeenCalled();
  expect(attachNewSimulator).toHaveBeenCalledWith({
    model: 'ipad',
    clues: [{ kind: 'OSVersion', osVersion: '27' }],
  });
});
