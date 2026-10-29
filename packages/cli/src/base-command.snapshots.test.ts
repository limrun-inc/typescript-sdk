import { XcodeCacheGoneError, type XcodeCacheConfig } from '@limrun/api';
import { BaseCommand } from './base-command';
import XcodeBuild from './commands/xcode/build';
import XcodeTest from './commands/xcode/test';
import XcodeSync from './commands/xcode/sync';
import XcodeCreate from './commands/xcode/create';
import IosCreate from './commands/ios/create';
import Run from './commands/run';
import { loadLastXcodeInstance, registerCreatedInstance } from './lib/config';
import { projectSnapshotKey } from './lib/snapshot-project';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastXcodeInstance: jest.fn(),
  registerCreatedInstance: jest.fn(),
}));
jest.mock('./lib/set-instance', () => ({ envInstanceTarget: () => undefined }));
jest.mock('./lib/snapshot-project', () => ({
  ...jest.requireActual('./lib/snapshot-project'),
  projectSnapshotConfig: (flags: Record<string, unknown>, dir: string) => {
    const { parseSnapshotConfig } = jest.requireActual('./lib/cache');
    return (
      parseSnapshotConfig(flags) ?? (flags['no-snapshot'] ? undefined : { key: projectSnapshotKey(dir) })
    );
  },
  projectSnapshotKey: jest.fn(() => 'github.com/acme/monorepo/apps/ios'),
}));

const target = { id: 'sandbox_euna_test', type: 'xcode' as const };
const instance = { metadata: { id: target.id } };
const load = jest.mocked(loadLastXcodeInstance);
const register = jest.mocked(registerCreatedInstance);

class TestCommand extends BaseCommand {
  create = jest.fn().mockResolvedValue(instance);
  follow = jest.fn().mockResolvedValue({
    cache: { restore: { phase: 'skipped', reason: 'no_match' }, save: { phase: 'idle' } },
  });
  bind = jest.fn();
  remove = jest.fn();
  override warn = jest.fn();
  getCache = jest.fn().mockResolvedValue({ restore: { phase: 'disabled' }, save: { phase: 'disabled' } });
  async run(): Promise<void> {}
  protected override info(): void {}
  protected override get client(): BaseCommand['client'] {
    return {
      xcodeInstances: {
        create: this.create,
        delete: this.remove,
        followCache: this.follow,
        bindCacheKey: this.bind,
        getCache: this.getCache,
      },
    } as unknown as BaseCommand['client'];
  }
  configure(flags: Record<string, unknown>, dir: string) {
    this.setParsedFlags(flags);
    this.snapshotProjectPath = dir;
  }
  resolve(id?: string) {
    return this.resolveXcodeTargetOrCreate(id);
  }
  apply(config?: XcodeCacheConfig) {
    return this.applyBuildCacheToTarget(target, config);
  }
  snapshotTip() {
    return this.buildSnapshotTip(target.id);
  }
}

test('build outcomes suggest a key for a sandbox without snapshots', async () => {
  const cmd = new TestCommand([], {} as never);
  expect(await cmd.snapshotTip()).toContain('--snapshot-key <project-key>');
  expect(cmd.getCache).toHaveBeenCalledWith(target.id, { timeout: 2000, maxRetries: 0 });
});

test.each([{ key: 'github.com/acme/app' }, { key: 'custom' }, { restoreKeys: ['main'] }])(
  'build outcomes omit the tip for existing snapshot config %j',
  async (config) => {
    const cmd = new TestCommand([], {} as never);
    cmd.getCache.mockResolvedValue({ config });
    expect(await cmd.snapshotTip()).toBe('');
  },
);

test('build outcomes respect snapshot opt-out and JSON output', async () => {
  const cmd = new TestCommand([], {} as never);
  cmd.configure({ 'no-snapshot': true }, '/repo');
  expect(await cmd.snapshotTip()).toBe('');
  cmd.configure({}, '/repo');
  Object.assign(cmd, { isJsonEnabled: () => true });
  expect(await cmd.snapshotTip()).toBe('');
  expect(cmd.getCache).not.toHaveBeenCalled();
});

test('snapshot status errors do not affect build outcomes', async () => {
  const cmd = new TestCommand([], {} as never);
  cmd.getCache.mockRejectedValue(new Error('status unavailable'));
  expect(await cmd.snapshotTip()).toBe('');
});

beforeEach(() => {
  jest.clearAllMocks();
  load.mockReturnValue(null);
  register.mockImplementation(() => {
    load.mockReturnValue(target);
    return target;
  });
});

test('auto-creation sends only the project key and waits for restore before returning', async () => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['xcode', 'build'] });
  cmd.configure({}, '/repo/apps/ios');
  await expect(cmd.resolve()).resolves.toEqual(target);
  expect(cmd.create).toHaveBeenCalledWith({
    wait: true,
    spec: { role: { permissions: [] }, cache: { key: 'github.com/acme/monorepo/apps/ios' } },
  });
  expect(projectSnapshotKey).toHaveBeenCalledWith('/repo/apps/ios');
  expect(cmd.follow).toHaveBeenCalledWith(target.id, expect.any(Object));
  expect(cmd.create.mock.invocationCallOrder[0]).toBeLessThan(cmd.follow.mock.invocationCallOrder[0]!);
});

test('opt-out creates without snapshots or a restore wait', async () => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['xcode', 'build'] });
  cmd.configure({ 'no-snapshot': true }, '/repo');
  await cmd.resolve();
  expect(cmd.create).toHaveBeenCalledWith({ wait: true, spec: { role: { permissions: [] } } });
  expect(cmd.follow).not.toHaveBeenCalled();
});

test('existing instances are neither replaced nor rebound by the default', async () => {
  load.mockReturnValue(target);
  const cmd = new TestCommand([], {} as never);
  cmd.configure({}, '/repo');
  await expect(cmd.resolve()).resolves.toEqual(target);
  await cmd.apply(undefined);
  expect(cmd.create).not.toHaveBeenCalled();
  expect(cmd.bind).not.toHaveBeenCalled();
  expect(projectSnapshotKey).not.toHaveBeenCalled();
  await cmd.apply({ key: 'explicit' });
  expect(cmd.bind).toHaveBeenCalledWith(target.id, 'explicit');
});

test.each([XcodeBuild, XcodeTest, XcodeSync])(
  '%s selects the sync path before resolving an instance',
  async (Command) => {
    const cmd = new Command([], {} as never);
    const stop = new Error('stop before remote work');
    const resolve = jest.fn(async () => {
      (cmd as unknown as { cacheConfigFromFlags(): unknown }).cacheConfigFromFlags();
      throw stop;
    });
    Object.assign(cmd, {
      parse: async () => ({ args: { path: '/different-repo/apps/ios' }, flags: {} }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      resolveXcodeTargetOrCreate: resolve,
      resolveSimulatorBackedXcodeTargetOrCreate: resolve,
      info: jest.fn(),
    });
    await expect(cmd.run()).rejects.toThrow(stop);
    expect(projectSnapshotKey).toHaveBeenCalledWith('/different-repo/apps/ios');
  },
);

test('explicit create derives its default from the current directory before creating', async () => {
  const cmd = new XcodeCreate([], {} as never);
  const stop = new Error('stop before remote work');
  Object.assign(cmd, {
    parse: async () => ({ flags: {} }),
    withAuth: async () => {
      throw stop;
    },
    info: jest.fn(),
  });
  await expect(cmd.run()).rejects.toThrow(stop);
  expect(projectSnapshotKey).toHaveBeenCalledWith(process.cwd());
});

test.each([{ permissions: [] }, { permissions: ['asset:name/fixtures/*:read'] }])(
  'onboarding keeps label reuse and creation permissions %j while restoring the snapshot',
  async ({ permissions }) => {
    const cmd = new Run([], {} as never);
    const stop = new Error('stop before building');
    const create = jest.fn().mockResolvedValue(instance);
    const followCache = jest.fn().mockResolvedValue({
      cache: { restore: { phase: 'restored' }, save: { phase: 'idle' } },
    });
    const sync = jest.fn().mockRejectedValue(stop);
    Object.defineProperty(cmd, 'client', {
      value: { xcodeInstances: { create, followCache, createClient: async () => ({ sync }) } },
    });
    Object.assign(cmd, {
      _parsedFlags: { permission: permissions },
      withAuth: async (fn: () => Promise<void>) => fn(),
      reporter: { withProgress: (_label: string, fn: () => Promise<unknown>) => fn() },
      outputProjectRecovery: jest.fn(),
      info: jest.fn(),
    });
    const launch = cmd as unknown as { buildAndLaunchProject(options: object): Promise<string> };
    await expect(launch.buildAndLaunchProject({ projectRoot: '/repo/apps/ios' })).rejects.toThrow(stop);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        reuseIfExists: true,
        spec: { role: { permissions }, cache: { key: 'github.com/acme/monorepo/apps/ios' } },
      }),
    );
    expect(projectSnapshotKey).toHaveBeenCalledWith('/repo/apps/ios');
    expect(followCache.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]!);
  },
);

test.each([{ permissions: [] }, { permissions: ['asset:name/fixtures/*:read'] }])(
  'ios create --xcode forwards permissions %j to the builder',
  async ({ permissions }) => {
    const cmd = new IosCreate([], {} as never);
    const stop = new Error('stop before attach');
    const create = jest.fn().mockResolvedValue(instance);
    const followCache = jest.fn().mockResolvedValue({
      cache: { restore: { phase: 'restored' }, save: { phase: 'idle' } },
    });
    const createClient = jest.fn().mockRejectedValue(stop);
    Object.defineProperty(cmd, 'client', {
      value: {
        iosInstances: {
          create: async () => ({ metadata: { id: 'ios_test' }, spec: { role: { permissions } }, status: {} }),
        },
        xcodeInstances: { create, followCache, createClient, delete: jest.fn().mockResolvedValue(undefined) },
      },
    });
    Object.assign(cmd, {
      parse: async () => ({ args: {}, flags: { xcode: true, permission: permissions } }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      info: jest.fn(),
    });
    await expect(cmd.run()).rejects.toThrow(stop);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: { role: { permissions }, cache: { key: 'github.com/acme/monorepo/apps/ios' } },
      }),
    );
    expect(followCache.mock.invocationCallOrder[0]).toBeLessThan(createClient.mock.invocationCallOrder[0]!);
  },
);

test.each(['checksum', 'transport'])(
  'a %s snapshot failure keeps the created instance available for the build',
  async (reason) => {
    const cmd = new TestCommand([], {} as never);
    Object.assign(cmd, { getCommandParts: () => ['xcode', 'build'] });
    cmd.configure({}, '/repo');
    cmd.follow.mockResolvedValue({
      cache: { restore: { phase: 'failed', reason }, save: { phase: 'idle' } },
    });
    await expect(cmd.resolve()).resolves.toEqual(target);
    expect(cmd.remove).not.toHaveBeenCalled();
    expect(cmd.warn).toHaveBeenCalledWith(expect.stringContaining('Continuing with a cold workspace.'));
  },
);

test('losing snapshot status does not block the build or delete its instance', async () => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['xcode', 'build'] });
  cmd.configure({}, '/repo');
  cmd.follow.mockRejectedValue(new Error('connection reset'));
  await expect(cmd.resolve()).resolves.toEqual(target);
  expect(cmd.remove).not.toHaveBeenCalled();
  expect(cmd.warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
});

test.each([
  { gone: true, cache: { restore: { phase: 'downloading' }, save: { phase: 'idle' } } },
  new XcodeCacheGoneError(target.id),
])('an instance that ended cannot continue building', async (outcome) => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['xcode', 'build'] });
  cmd.configure({}, '/repo');
  if (outcome instanceof Error) cmd.follow.mockRejectedValue(outcome);
  else cmd.follow.mockResolvedValue(outcome);
  await expect(cmd.resolve()).rejects.toThrow(/Instance .* (was gone|was collected)/);
  expect(cmd.remove).not.toHaveBeenCalled();
});
