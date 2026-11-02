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

test.each([
  ['--model', 'ipad', '--id', 'sandbox_euna_test'],
  ['--os-version', '27', '--build-only'],
])('rejects device selection for a run that creates no simulator: %j', async (...argv) => {
  const parsed = await parse(argv);
  const withAuth = jest.fn();
  const command = Object.assign(Object.create(XcodeTest.prototype), {
    parse: async () => ({ ...parsed, args: {} }),
    setParsedFlags: jest.fn(),
    withAuth,
    error: (message: string) => {
      throw new Error(message);
    },
  });
  await expect(command.run()).rejects.toThrow(/cannot be combined with --id or --build-only/);
  expect(withAuth).not.toHaveBeenCalled();
});

test('device selection skips the recorded target and attaches a simulator of that model and version', async () => {
  const recorded = { id: 'sandbox_euna_recorded', type: 'xcode' as const };
  const created = { id: 'sandbox_euna_new', type: 'xcode' as const };
  jest.mocked(loadLastXcodeInstance).mockReturnValue(recorded as never);
  const getSimulator = jest.fn();
  const attachNewSimulator = jest.fn().mockResolvedValue({ simulator: { metadata: { id: 'ios_euna_new' } } });
  const cmd = new XcodeTest([], {} as never);
  Object.assign(cmd, {
    _parsedFlags: { model: 'ipad', 'os-version': '27' },
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
