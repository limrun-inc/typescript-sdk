import { BaseCommand } from './base-command';
import { loadLastXcodeInstance, loadLastGradleInstance, registerCreatedInstance } from './lib/config';
import { delegatedPermissionsFromFlags } from './lib/delegated-permissions';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastXcodeInstance: jest.fn(),
  loadLastGradleInstance: jest.fn(),
  registerCreatedInstance: jest.fn(),
}));
jest.mock('./lib/set-instance', () => ({ envInstanceTarget: () => undefined }));

class TestCommand extends BaseCommand {
  createXcode = jest.fn().mockResolvedValue({ metadata: { id: 'sandbox_euna_test' } });
  createGradle = jest.fn().mockResolvedValue({ metadata: { id: 'gradle_euna_test' } });
  async run(): Promise<void> {}
  protected override info(): void {}
  protected override get client(): BaseCommand['client'] {
    return {
      xcodeInstances: { create: this.createXcode },
      gradleInstances: { create: this.createGradle },
    } as unknown as BaseCommand['client'];
  }
  configure(platform: string, flags: Record<string, unknown>) {
    this.setParsedFlags({ 'no-snapshot': true, ...flags });
    Object.assign(this, { getCommandParts: () => [platform, 'build'] });
  }
  resolve(platform: string, id?: string) {
    return platform === 'xcode' ? this.resolveXcodeTargetOrCreate(id) : this.resolveGradleTargetOrCreate(id);
  }
}

const targets = {
  xcode: { id: 'sandbox_euna_test', type: 'xcode' as const },
  gradle: { id: 'gradle_euna_test', type: 'gradle' as const },
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadLastXcodeInstance).mockReturnValue(null);
  jest.mocked(loadLastGradleInstance).mockReturnValue(null);
  jest.mocked(registerCreatedInstance).mockImplementation((instance) => {
    if (instance.metadata.id.startsWith('sandbox')) {
      jest.mocked(loadLastXcodeInstance).mockReturnValue(targets.xcode);
      return targets.xcode;
    }
    jest.mocked(loadLastGradleInstance).mockReturnValue(targets.gradle);
    return targets.gradle;
  });
});

test.each(['xcode', 'gradle'])(
  '%s auto-create sends the union of customer and upload permissions',
  async (platform) => {
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'preview/app.apk', permission: ['asset:name/input.zip:read'] });
    await command.resolve(platform);
    const create = platform === 'xcode' ? command.createXcode : command.createGradle;
    expect(create).toHaveBeenCalledWith({
      wait: true,
      spec: {
        delegatedPermissions: [
          'asset:name/input.zip:read',
          'asset:name/preview%2Fapp.apk:create',
          'asset:name/preview%2Fapp.apk:upload',
          'asset:name/preview%2Fapp.apk:update',
        ],
      },
    });
  },
);

test.each(['xcode', 'gradle'])('%s signed URL creates without extra workload grants', async (platform) => {
  const command = new TestCommand([], {} as never);
  command.configure(platform, { 'signed-upload-url': 'https://storage.example/upload' });
  await command.resolve(platform);
  expect(platform === 'xcode' ? command.createXcode : command.createGradle).toHaveBeenCalledWith({
    wait: true,
    spec: {},
  });
});

test.each(['xcode', 'gradle'] as const)(
  '%s does not silently reuse a cached instance with unknown grants',
  async (platform) => {
    jest
      .mocked(platform === 'xcode' ? loadLastXcodeInstance : loadLastGradleInstance)
      .mockReturnValue(targets[platform] as never);
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'result.apk' });
    await command.resolve(platform);
    expect(platform === 'xcode' ? command.createXcode : command.createGradle).toHaveBeenCalledTimes(1);
  },
);

test.each(['xcode', 'gradle'])(
  '%s refuses adding permissions to an explicit existing instance',
  async (platform) => {
    const command = new TestCommand([], {} as never);
    command.configure(platform, { permission: ['asset:name/result.apk:upload'] });
    await expect(
      command.resolve(platform, platform === 'xcode' ? targets.xcode.id : targets.gradle.id),
    ).rejects.toThrow('applies at instance creation');
    expect(command.createXcode).not.toHaveBeenCalled();
    expect(command.createGradle).not.toHaveBeenCalled();
  },
);

test('RBE auto-upload adds the named target and preserves customer permissions', () => {
  expect(
    delegatedPermissionsFromFlags({ 'auto-upload': 'result.ipa', permission: ['asset:name/input.zip:read'] }),
  ).toEqual([
    'asset:name/input.zip:read',
    'asset:name/result.ipa:create',
    'asset:name/result.ipa:upload',
    'asset:name/result.ipa:update',
  ]);
});

test.each(['xcode', 'gradle'] as const)(
  '%s uploads to an explicit instance without creating a replacement',
  async (platform) => {
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'result.apk' });
    const target = await command.resolve(platform, targets[platform].id);
    expect(target.id).toBe(targets[platform].id);
    expect(command.createXcode).not.toHaveBeenCalled();
    expect(command.createGradle).not.toHaveBeenCalled();
  },
);

test.each(['xcode', 'gradle'] as const)(
  '%s respects --no-create when a cached role cannot be verified',
  async (platform) => {
    jest
      .mocked(platform === 'xcode' ? loadLastXcodeInstance : loadLastGradleInstance)
      .mockReturnValue(targets[platform] as never);
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'result.apk', create: false });
    await expect(command.resolve(platform)).rejects.toThrow();
    expect(command.createXcode).not.toHaveBeenCalled();
    expect(command.createGradle).not.toHaveBeenCalled();
  },
);
