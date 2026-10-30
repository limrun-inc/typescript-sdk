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
  '%s uploads from the prepared workspace after updating the live workload role',
  async (Command, platform, id, loadLast) => {
    jest.mocked(loadLast).mockReturnValue({ id, type: platform } as never);
    const stop = new Error('captured build submission');
    const build = jest.fn(() => {
      throw stop;
    });
    const sync = jest.fn().mockResolvedValue({ bytesSent: 0 });
    const update = jest.fn().mockResolvedValue(undefined);
    const get = jest.fn(() => ({
      withResponse: async () => ({
        data: { spec: { role: { permissions: ['asset:name/input:read'] } }, status: { state: 'ready' } },
        response: new Response(null, { headers: { etag: '"42"' } }),
      }),
    }));
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
        xcodeInstances: { create, get, update },
        gradleInstances: { create, get, update },
      },
    });
    await expect(command.run()).rejects.toThrow(stop);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(id, {
      ifMatch: '"42"',
      spec: {
        role: {
          permissions: [
            'asset:name/input:read',
            'asset:name/releases/app.ipa:create',
            'asset:name/releases/app.ipa:upload',
            'asset:name/releases/app.ipa:update',
          ],
        },
      },
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
        }),
      }),
    );
  },
);

test.each([
  [XcodeBuild, 'xcode', 'sandbox_euna_prepared', loadLastXcodeInstance],
  [GradleBuild, 'gradle', 'gradle_euna_prepared', loadLastGradleInstance],
] as const)(
  '%s signed URL uploads never read or change permissions',
  async (Command, platform, id, loadLast) => {
    jest.mocked(loadLast).mockReturnValue({ id, type: platform } as never);
    const stop = new Error('captured signed upload');
    const build = jest.fn(() => {
      throw stop;
    });
    const sync = jest.fn().mockResolvedValue({ bytesSent: 0 });
    const get = jest.fn();
    const update = jest.fn();
    const create = jest.fn();
    const command = new Command([], {} as never);
    Object.assign(command, {
      parse: async () => ({
        args: { path: process.cwd() },
        flags: { 'signed-upload-url': 'https://storage.example/upload', 'no-snapshot': true, create: false },
      }),
      withAuth: async (run: () => Promise<void>) => run(),
      getCommandParts: () => [platform, 'build'],
      applyBuildCacheToTarget: jest.fn(),
      resolveXcodeClientForWork: jest.fn(async () => ({ sync, xcodebuild: build })),
      resolveGradleClient: jest.fn(async () => ({ sync, gradlebuild: build })),
      info: jest.fn(),
    });
    Object.defineProperty(command, 'client', {
      value: { xcodeInstances: { get, update, create }, gradleInstances: { get, update, create } },
    });
    await expect(command.run()).rejects.toThrow(stop);
    expect(update).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    const args = build.mock.calls[0] as unknown as unknown[];
    expect(args[platform === 'xcode' ? 1 : 0]).toEqual(
      expect.objectContaining({ upload: { signedUploadUrl: 'https://storage.example/upload' } }),
    );
  },
);
