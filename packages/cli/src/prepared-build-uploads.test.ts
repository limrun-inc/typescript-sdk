import XcodeBuild from './commands/xcode/build';
import GradleBuild from './commands/gradle/build';
import { loadLastXcodeInstance, loadLastGradleInstance } from './lib/config';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastXcodeInstance: jest.fn(),
  loadLastGradleInstance: jest.fn(),
}));
jest.mock('./lib/set-instance', () => ({ envInstanceTarget: () => undefined }));

beforeEach(() => jest.clearAllMocks());

test.each([
  [XcodeBuild, 'xcode', 'sandbox_euna_prepared', loadLastXcodeInstance],
  [GradleBuild, 'gradle', 'gradle_euna_prepared', loadLastGradleInstance],
] as const)(
  '%s uploads from the prepared workspace with caller-scoped authority',
  async (Command, platform, id, loadLast) => {
    jest.mocked(loadLast).mockReturnValue({ id, type: platform } as never);
    const stop = new Error('captured build submission');
    const build = jest.fn(() => {
      throw stop;
    });
    const sync = jest.fn().mockResolvedValue({ bytesSent: 0 });
    const mint = jest.fn().mockResolvedValue({ token: 'upload-only-token' });
    const create = jest.fn();
    const command = new Command([], {} as never);
    Object.assign(command, {
      parse: async () => ({
        args: { path: process.cwd() },
        flags: {
          upload: 'releases/app.ipa',
          'no-snapshot': true,
          create: false,
        },
      }),
      withAuth: async (run: () => Promise<void>) => run(),
      getCommandParts: () => [platform, 'build'],
      applyBuildCacheToTarget: jest.fn(),
      resolveXcodeClientForWork: jest.fn(async () => ({ sync, xcodebuild: build })),
      resolveGradleClient: jest.fn(async () => ({ sync, gradlebuild: build })),
      info: jest.fn(),
    });
    Object.defineProperty(command, 'client', {
      value: {
        accessTokens: { create: mint },
        xcodeInstances: { create },
        gradleInstances: { create },
      },
    });
    await expect(command.run()).rejects.toThrow(stop);
    expect(create).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledWith({
      permissions: [
        'asset:name/releases/app.ipa:create',
        'asset:name/releases/app.ipa:upload',
        'asset:name/releases/app.ipa:update',
      ],
      ttlSeconds: 14400,
    });
    const resolver =
      platform === 'xcode' ? command['resolveXcodeClientForWork'] : command['resolveGradleClient'];
    expect(resolver).toHaveBeenCalledWith(
      ...(platform === 'xcode' ?
        [expect.objectContaining({ id }), undefined]
      : [expect.objectContaining({ id })]),
    );
    const options = build.mock.calls[0] as unknown as unknown[];
    expect(options[platform === 'xcode' ? 1 : 0]).toEqual(
      expect.objectContaining({
        upload: expect.objectContaining({
          target: 'name/releases/app.ipa',
          token: 'upload-only-token',
        }),
      }),
    );
  },
);
