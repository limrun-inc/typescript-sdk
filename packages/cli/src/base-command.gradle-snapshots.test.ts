import { GradleSnapshotGoneError } from '@limrun/api';
import { BaseCommand } from './base-command';
import GradleBuild from './commands/gradle/build';
import GradleSync from './commands/gradle/sync';
import { loadLastGradleInstance, registerCreatedInstance } from './lib/config';
import { projectSnapshotKey } from './lib/snapshot-project';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastGradleInstance: jest.fn(),
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
  projectSnapshotKey: jest.fn(() => 'github.com/acme/monorepo/apps/android'),
}));

const target = { id: 'gradle_euna_test', type: 'gradle' as const };
const instance = { metadata: { id: target.id } };
const load = jest.mocked(loadLastGradleInstance);
const register = jest.mocked(registerCreatedInstance);

// The Gradle commands share Xcode's snapshot helpers through a kind, so these mirror the Xcode
// cases in base-command.snapshots.test.ts against the Gradle API.
class TestCommand extends BaseCommand {
  create = jest.fn().mockResolvedValue(instance);
  follow = jest.fn().mockResolvedValue({
    snapshot: { restore: { phase: 'skipped', reason: 'no_match' }, save: { phase: 'idle' } },
    gone: false,
  });
  bind = jest.fn();
  getSnapshot = jest.fn().mockResolvedValue({ restore: { phase: 'disabled' }, save: { phase: 'disabled' } });
  xcodeFollow = jest.fn();
  override warn = jest.fn();
  async run(): Promise<void> {}
  protected override info(): void {}
  protected override get client(): BaseCommand['client'] {
    return {
      gradleInstances: {
        create: this.create,
        followSnapshot: this.follow,
        bindSnapshotKey: this.bind,
        getSnapshot: this.getSnapshot,
      },
      xcodeInstances: { followCache: this.xcodeFollow },
    } as unknown as BaseCommand['client'];
  }
  configure(flags: Record<string, unknown>, dir: string) {
    this.setParsedFlags(flags);
    this.snapshotProjectPath = dir;
  }
  resolve(id?: string) {
    return this.resolveGradleTargetOrCreate(id);
  }
  apply(config?: { key?: string; restoreKeys?: string[] }) {
    return this.applyBuildCacheToTarget(target, config, 'gradle');
  }
  snapshotTip() {
    return this.buildSnapshotTip(target.id, 'gradle');
  }
  restore() {
    return this.awaitCacheRestore(target.id, 'gradle');
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  load.mockReturnValue(null);
  register.mockImplementation(() => target);
});

test('auto-creation without snapshot flags creates without a snapshot or a restore wait', async () => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['gradle', 'build'] });
  cmd.configure({}, '/repo/apps/android');
  await expect(cmd.resolve()).resolves.toEqual(target);
  expect(cmd.create).toHaveBeenCalledWith({ wait: true, spec: { role: { permissions: [] } } });
  // Gradle snapshots are opt-in: the project's Git origin is never read for a key.
  expect(projectSnapshotKey).not.toHaveBeenCalled();
  expect(cmd.follow).not.toHaveBeenCalled();
});

test('auto-creation sends an explicit key and waits for the restore before returning', async () => {
  const cmd = new TestCommand([], {} as never);
  Object.assign(cmd, { getCommandParts: () => ['gradle', 'build'] });
  cmd.configure({ 'snapshot-key': 'github.com/acme/monorepo/apps/android' }, '/repo/apps/android');
  await expect(cmd.resolve()).resolves.toEqual(target);
  expect(cmd.create).toHaveBeenCalledWith({
    wait: true,
    spec: { role: { permissions: [] }, snapshot: { key: 'github.com/acme/monorepo/apps/android' } },
  });
  expect(cmd.follow).toHaveBeenCalledWith(target.id, expect.objectContaining({ side: 'restore' }));
  expect(cmd.xcodeFollow).not.toHaveBeenCalled();
  expect(cmd.create.mock.invocationCallOrder[0]).toBeLessThan(cmd.follow.mock.invocationCallOrder[0]!);
});

test('existing instances are not rebound without a key, and an explicit key binds once', async () => {
  load.mockReturnValue(target);
  const cmd = new TestCommand([], {} as never);
  cmd.configure({}, '/repo');
  await expect(cmd.resolve()).resolves.toEqual(target);
  await cmd.apply(undefined);
  expect(cmd.create).not.toHaveBeenCalled();
  expect(cmd.bind).not.toHaveBeenCalled();
  await cmd.apply({ key: 'explicit' });
  expect(cmd.bind).toHaveBeenCalledWith(target.id, 'explicit');
});

test('build outcomes suggest a key for a sandbox without a snapshot', async () => {
  const cmd = new TestCommand([], {} as never);
  expect(await cmd.snapshotTip()).toContain('--snapshot-key <project-key>');
  expect(cmd.getSnapshot).toHaveBeenCalledWith(target.id, { timeout: 2000, maxRetries: 0 });
  cmd.getSnapshot.mockResolvedValue({ config: { key: 'github.com/acme/app' } });
  expect(await cmd.snapshotTip()).toBe('');
});

test('an instance collected before its restore started is an error, not a cold build', async () => {
  const cmd = new TestCommand([], {} as never);
  cmd.follow.mockRejectedValue(new GradleSnapshotGoneError(target.id));
  await expect(cmd.restore()).rejects.toThrow('collected before its disk snapshot restore started');
});

test.each([GradleBuild, GradleSync])(
  '%s derives no snapshot key from the project it syncs',
  async (Command) => {
    const cmd = new Command([], {} as never);
    const stop = new Error('stop before remote work');
    let config: unknown = 'unset';
    const resolve = jest.fn(async () => {
      config = (cmd as unknown as { cacheConfigFromFlags(kind: string): unknown }).cacheConfigFromFlags(
        'gradle',
      );
      throw stop;
    });
    Object.assign(cmd, {
      parse: async () => ({ args: { path: '/different-repo/apps/android' }, flags: {} }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      resolveGradleTargetOrCreate: resolve,
      info: jest.fn(),
    });
    await expect(cmd.run()).rejects.toThrow(stop);
    expect(config).toBeUndefined();
    expect(projectSnapshotKey).not.toHaveBeenCalled();
  },
);
