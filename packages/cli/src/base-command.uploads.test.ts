import { APIError } from '@limrun/api';
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
  update = jest.fn().mockResolvedValue(undefined);
  live = jest.fn().mockResolvedValue({
    data: { spec: { role: { permissions: ['asset:name/input.zip:read'] } }, status: { state: 'ready' } },
    response: new Response(null, { headers: { etag: '"42"' } }),
  });
  get = jest.fn(() => ({ withResponse: this.live }));
  authorizeUpload(id: string, name: string) {
    return this.ensureUploadPermissions(id, name);
  }
  createXcode = jest.fn().mockResolvedValue({ metadata: { id: 'sandbox_euna_test' } });
  createGradle = jest.fn().mockResolvedValue({ metadata: { id: 'gradle_euna_test' } });
  async run(): Promise<void> {}
  protected override info(): void {}
  protected override get client(): BaseCommand['client'] {
    return {
      xcodeInstances: { create: this.createXcode, get: this.get, update: this.update },
      gradleInstances: { create: this.createGradle, get: this.get, update: this.update },
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
        role: {
          permissions: [
            'asset:name/input.zip:read',
            'asset:name/preview/app.apk:create',
            'asset:name/preview/app.apk:upload',
            'asset:name/preview/app.apk:update',
          ],
        },
      },
    });
  },
);

test.each(['xcode', 'gradle'])(
  '%s --upload alone grants exactly what the new workload needs',
  async (platform) => {
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'releases/app.ipa' });
    await command.resolve(platform);
    expect(platform === 'xcode' ? command.createXcode : command.createGradle).toHaveBeenCalledWith({
      wait: true,
      spec: {
        role: {
          permissions: [
            'asset:name/releases/app.ipa:create',
            'asset:name/releases/app.ipa:upload',
            'asset:name/releases/app.ipa:update',
          ],
        },
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
    spec: { role: { permissions: [] } },
  });
});

test.each(['xcode', 'gradle'] as const)(
  '%s keeps the prepared instance when a later build requests upload',
  async (platform) => {
    jest
      .mocked(platform === 'xcode' ? loadLastXcodeInstance : loadLastGradleInstance)
      .mockReturnValue(targets[platform] as never);
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'result.apk' });
    const target = await command.resolve(platform);
    expect(target.id).toBe(targets[platform].id);
    expect(platform === 'xcode' ? command.createXcode : command.createGradle).not.toHaveBeenCalled();
    await expect(command.authorizeUpload(target.id, 'result.apk')).resolves.toBeUndefined();
    expect(command.update).toHaveBeenCalledWith(target.id, {
      ifMatch: '"42"',
      spec: {
        role: {
          permissions: [
            'asset:name/input.zip:read',
            'asset:name/result.apk:create',
            'asset:name/result.apk:upload',
            'asset:name/result.apk:update',
          ],
        },
      },
    });
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
  '%s keeps the prepared upload target with --no-create',
  async (platform) => {
    jest
      .mocked(platform === 'xcode' ? loadLastXcodeInstance : loadLastGradleInstance)
      .mockReturnValue(targets[platform] as never);
    const command = new TestCommand([], {} as never);
    command.configure(platform, { upload: 'result.apk', create: false });
    await expect(command.resolve(platform)).resolves.toEqual(targets[platform]);
    expect(command.createXcode).not.toHaveBeenCalled();
    expect(command.createGradle).not.toHaveBeenCalled();
  },
);

test('CLI upload grants preserve literal names and deduplicate without changing customer permissions', () => {
  const permission = ['asset:name/input.zip:read', 'asset:name/release/a:42%.apk:upload'];
  const before = [...permission];
  expect(delegatedPermissionsFromFlags({ upload: 'release/a:42%.apk', permission })).toEqual([
    ...permission,
    'asset:name/release/a:42%.apk:create',
    'asset:name/release/a:42%.apk:update',
  ]);
  expect(permission).toEqual(before);
});

// Automatic grants must not broaden a literal upload name into a pattern.
test.each(['upload', 'auto-upload'])('%s refuses wildcard characters in automatic grants', (flag) => {
  for (const name of ['releases/app-*.apk', 'releases/app-?.apk']) {
    expect(() => delegatedPermissionsFromFlags({ [flag]: name })).toThrow('automatic permissions');
  }
});

test('skips PATCH when the live instance already has the required grants', async () => {
  const command = new TestCommand([], {} as never);
  command.live.mockResolvedValue({
    data: {
      spec: { role: { permissions: delegatedPermissionsFromFlags({ upload: 'result.apk' })! } },
      status: { state: 'ready' },
    },
    response: new Response(null, { headers: { etag: '"42"' } }),
  });
  await command.authorizeUpload(targets.xcode.id, 'result.apk');
  expect(command.update).not.toHaveBeenCalled();
});

test('denied delegation fails without creating another instance', async () => {
  const command = new TestCommand([], {} as never);
  command.update.mockRejectedValue(new Error('requested permissions exceed caller authority'));
  await expect(command.authorizeUpload(targets.xcode.id, 'result.ipa')).rejects.toThrow(
    'exceed caller authority',
  );
  expect(command.createXcode).not.toHaveBeenCalled();
});

test('recomputes the union after a concurrent permission update', async () => {
  const command = new TestCommand([], {} as never);
  command.update.mockRejectedValueOnce(new APIError(412, { message: 'changed' }, 'changed', new Headers()));
  command.live.mockResolvedValueOnce({
    data: { spec: { role: { permissions: ['asset:name/old:read'] } }, status: { state: 'ready' } },
    response: new Response(null, { headers: { etag: '"41"' } }),
  });
  await command.authorizeUpload(targets.xcode.id, 'result.ipa');
  expect(command.update).toHaveBeenNthCalledWith(2, targets.xcode.id, {
    ifMatch: '"42"',
    spec: {
      role: {
        permissions: [
          'asset:name/input.zip:read',
          'asset:name/result.ipa:create',
          'asset:name/result.ipa:upload',
          'asset:name/result.ipa:update',
        ],
      },
    },
  });
  expect(command.update.mock.calls[1][1].spec.role.permissions).not.toContain('asset:name/old:read');
});

test('conflict retries are bounded', async () => {
  const command = new TestCommand([], {} as never);
  command.update.mockRejectedValue(new APIError(412, { message: 'changed' }, 'changed', new Headers()));
  await expect(command.authorizeUpload(targets.xcode.id, 'result.ipa')).rejects.toMatchObject({
    status: 412,
  });
  expect(command.update).toHaveBeenCalledTimes(3);
});

test('historical or older server responses fail without changing the role', async () => {
  const command = new TestCommand([], {} as never);
  command.live.mockResolvedValue({
    data: { spec: {}, status: { state: 'terminated' } },
    response: new Response(null),
  });
  await expect(command.authorizeUpload(targets.xcode.id, 'result.ipa')).rejects.toThrow(
    'no editable live role',
  );
  expect(command.update).not.toHaveBeenCalled();
});

test('duplicate stored grants cannot hide a missing upload permission', async () => {
  const command = new TestCommand([], {} as never);
  command.live.mockResolvedValue({
    data: {
      spec: { role: { permissions: Array(4).fill('asset:name/input:read') } },
      status: { state: 'ready' },
    },
    response: new Response(null, { headers: { etag: '"42"' } }),
  });
  await command.authorizeUpload(targets.xcode.id, 'result.ipa');
  expect(command.update).toHaveBeenCalledWith(targets.xcode.id, {
    ifMatch: '"42"',
    spec: {
      role: {
        permissions: [
          'asset:name/input:read',
          'asset:name/result.ipa:create',
          'asset:name/result.ipa:upload',
          'asset:name/result.ipa:update',
        ],
      },
    },
  });
});

test.each(['sandbox_euna_test', 'xcode_euna_test'])(
  'upload grants use the Xcode resource for %s',
  async (id) => {
    const command = new TestCommand([], {} as never);
    Object.defineProperty(command, 'client', {
      get: () => ({ xcodeInstances: { get: command.get, update: command.update } }),
    });
    await command.authorizeUpload(id, 'result.ipa');
    expect(command.get).toHaveBeenCalledWith(id);
    expect(command.update).toHaveBeenCalledWith(id, {
      ifMatch: '"42"',
      spec: {
        role: {
          permissions: [
            'asset:name/input.zip:read',
            'asset:name/result.ipa:create',
            'asset:name/result.ipa:upload',
            'asset:name/result.ipa:update',
          ],
        },
      },
    });
  },
);
