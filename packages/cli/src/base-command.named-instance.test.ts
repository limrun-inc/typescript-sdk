import { NotFoundError } from '@limrun/api';
import { BaseCommand } from './base-command';
import {
  loadLastAndroidInstance,
  loadLastGradleInstance,
  loadLastIosInstance,
  loadLastXcodeInstance,
  readConfig,
} from './lib/config';
import { envInstanceTarget } from './lib/set-instance';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  readConfig: jest.fn(),
  loadLastGradleInstance: jest.fn(),
  loadLastAndroidInstance: jest.fn(),
  loadLastIosInstance: jest.fn(),
  loadLastXcodeInstance: jest.fn(),
  clearLastInstanceId: jest.fn(),
}));
jest.mock('./lib/daemon', () => ({ ...jest.requireActual('./lib/daemon'), stopDaemon: jest.fn() }));
jest.mock('./lib/set-instance', () => ({ envInstanceTarget: jest.fn(() => null) }));

const readConfigMock = jest.mocked(readConfig);
const loadLastGradle = jest.mocked(loadLastGradleInstance);
const remembered = {
  gradle: jest.mocked(loadLastGradleInstance),
  android: jest.mocked(loadLastAndroidInstance),
  ios: jest.mocked(loadLastIosInstance),
  xcode: jest.mocked(loadLastXcodeInstance),
};
const envTarget = jest.mocked(envInstanceTarget);

class TestCommand extends BaseCommand {
  replace = jest.fn();
  async run(): Promise<void> {}
  protected override info(): void {}
  protected override get client(): BaseCommand['client'] {
    return {} as BaseCommand['client'];
  }
  constructor(noun: string) {
    super([], {} as never);
    Object.assign(this, { getCommandParts: () => [noun, 'build'], createReplacementInstance: this.replace });
    (this as unknown as { _parsedFlags: Record<string, unknown> })._parsedFlags = {};
  }
  // Each kind resolves its target, then the work finds the instance gone.
  async workOn(resolve: (cmd: TestCommand) => unknown | Promise<unknown>): Promise<string[]> {
    const ids: string[] = [];
    await this.withAuth(async () => {
      const target = (await resolve(this)) as { id: string };
      ids.push(target.id);
      if (ids.length === 1) {
        throw new NotFoundError(
          404,
          { message: `instance ${target.id} not found` },
          undefined,
          new Headers(),
        );
      }
    });
    return ids;
  }
  gradle(id?: string) {
    return this.resolveGradleTarget(id);
  }
  android(id?: string) {
    return this.resolveAndroidInstance(id);
  }
  ios(id?: string) {
    return this.resolveIosInstance(id);
  }
  xcode(id?: string) {
    return this.resolveXcodeTarget(id);
  }
  xcodeWithSimulator(id?: string) {
    return this.resolveSimulatorBackedXcodeTargetOrCreate(id);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const load of Object.values(remembered)) load.mockReturnValue(null);
  readConfigMock.mockReturnValue({
    apiKey: 'lim_test',
    apiEndpoint: 'https://api.example.test',
    consoleEndpoint: 'https://console.example.test',
  });
  envTarget.mockReturnValue(null);
});

test.each([
  ['gradle', 'gradle_euna_01h455vb4pex5vsknk084sn02q', (cmd: TestCommand, id: string) => cmd.gradle(id)],
  ['android', 'android_euna_01h455vb4pex5vsknk084sn02q', (cmd: TestCommand, id: string) => cmd.android(id)],
  ['ios', 'ios_euna_01h455vb4pex5vsknk084sn02q', (cmd: TestCommand, id: string) => cmd.ios(id)],
  ['xcode', 'xcode_euna_01h455vb4pex5vsknk084sn02q', (cmd: TestCommand, id: string) => cmd.xcode(id)],
])('a %s instance named by ID fails when gone instead of being replaced', async (noun, id, resolve) => {
  const cmd = new TestCommand(noun);
  await expect(cmd.workOn((c) => resolve(c, id))).rejects.toThrow(
    `Instance ${id} was not found; it may have ended. An instance named with --id or an env pin is never replaced.`,
  );
  expect(cmd.replace).not.toHaveBeenCalled();
});

test('an instance pinned by env fails when gone instead of being replaced', async () => {
  const pinned = { id: 'gradle_euna_01h455vb4pex5vsknk084sn02q', type: 'gradle' as const };
  envTarget.mockImplementation(((type: string) => (type === 'gradle' ? pinned : null)) as never);
  const cmd = new TestCommand('gradle');
  await expect(cmd.workOn((c) => c.gradle())).rejects.toThrow('is never replaced');
  expect(cmd.replace).not.toHaveBeenCalled();
});

test('a remembered instance that is gone is still replaced', async () => {
  const remembered = { id: 'gradle_euna_01h455vb4pex5vsknk084sn02q', type: 'gradle' as const };
  const replacement = { id: 'gradle_euna_01h455vb4pex5vsknk084sn02r', type: 'gradle' as const };
  loadLastGradle.mockReturnValue(remembered as never);
  const cmd = new TestCommand('gradle');
  cmd.replace.mockResolvedValue(replacement);
  await expect(cmd.workOn((c) => c.gradle())).resolves.toEqual([remembered.id, replacement.id]);
  expect(cmd.replace).toHaveBeenCalledWith(remembered.id);
});

test.each([
  ['gradle', (cmd: TestCommand) => cmd.gradle()],
  ['android', (cmd: TestCommand) => cmd.android()],
  ['ios', (cmd: TestCommand) => cmd.ios()],
  ['xcode', (cmd: TestCommand) => cmd.xcode()],
] as const)('a remembered %s instance that is gone is still replaced', async (noun, resolve) => {
  const id = `${noun}_euna_01h455vb4pex5vsknk084sn02q`;
  const replacement = { id: `${noun}_euna_01h455vb4pex5vsknk084sn02r`, type: noun };
  remembered[noun].mockReturnValue({ id, type: noun } as never);
  const cmd = new TestCommand(noun);
  cmd.replace.mockResolvedValue(replacement);
  await expect(cmd.workOn(resolve)).resolves.toEqual([id, replacement.id]);
  expect(cmd.replace).toHaveBeenCalledWith(id);
});

// --ios checks the named sandbox for a simulator before the command records it, so its 404 comes
// first. That 404 must fail too, not slip through to a replacement.
test('an Xcode instance named for --ios that is gone fails before its simulator check', async () => {
  const id = 'xcode_euna_01h455vb4pex5vsknk084sn02q';
  const cmd = new TestCommand('xcode');
  Object.assign(cmd, {
    resolveXcodeClient: jest.fn(async () => {
      throw new NotFoundError(404, { message: `instance ${id} not found` }, undefined, new Headers());
    }),
  });
  await expect(cmd.workOn((c) => c.xcodeWithSimulator(id))).rejects.toThrow('is never replaced');
  expect(cmd.replace).not.toHaveBeenCalled();
});
