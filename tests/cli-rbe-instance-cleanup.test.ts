import { BaseCommand } from '../packages/cli/src/base-command';

/**
 * Pins the instance-leak guard: `lim xcode rbe` must delete a server-side
 * instance it auto-created and then abandons (e.g. one that turns out not to
 * support RBE), but never delete a user `--id` or a pre-existing cached
 * instance. The cleanup is keyed off `_instancesCreatedThisRun`, so these tests
 * drive the protected helpers directly via a tiny subclass with a fake client.
 */

class TestCommand extends BaseCommand {
  xcodeDelete = jest.fn<Promise<void>, [string]>(async () => {});
  iosDelete = jest.fn<Promise<void>, [string]>(async () => {});

  // Fake client exposing only the delete methods the cleanup helper touches.
  protected get client(): any {
    return {
      xcodeInstances: { delete: this.xcodeDelete },
      iosInstances: { delete: this.iosDelete },
    };
  }

  async run(): Promise<void> {}

  // Test seams onto the protected surface under test.
  markCreated(id: string): void {
    this._instancesCreatedThisRun.add(id);
  }
  wasCreated(id: string | undefined): boolean {
    return this.wasCreatedThisRun(id);
  }
  cleanup(id: string | undefined): Promise<boolean> {
    return this.deleteCreatedInstance(id);
  }
}

function newCommand(): TestCommand {
  return new TestCommand([], {} as never);
}

const CREATED_XCODE = 'sandbox_euna_01created';
const USER_XCODE = 'sandbox_user_01pinned';
const SIM_IOS = 'ios_sim_01attached';

describe('rbe instance-leak cleanup', () => {
  test('deletes an xcode instance we created, and is idempotent', async () => {
    const cmd = newCommand();
    cmd.markCreated(CREATED_XCODE);
    expect(cmd.wasCreated(CREATED_XCODE)).toBe(true);

    await expect(cmd.cleanup(CREATED_XCODE)).resolves.toBe(true);
    expect(cmd.xcodeDelete).toHaveBeenCalledTimes(1);
    expect(cmd.xcodeDelete).toHaveBeenCalledWith(CREATED_XCODE);

    // Dropped from the set on success, so a second attempt is a no-op.
    await expect(cmd.cleanup(CREATED_XCODE)).resolves.toBe(false);
    expect(cmd.xcodeDelete).toHaveBeenCalledTimes(1);
  });

  test('never deletes an instance we did not create (user --id / pre-existing / undefined)', async () => {
    const cmd = newCommand();
    for (const id of [USER_XCODE, SIM_IOS, undefined]) {
      expect(cmd.wasCreated(id)).toBe(false);
      await expect(cmd.cleanup(id)).resolves.toBe(false);
    }
    expect(cmd.xcodeDelete).not.toHaveBeenCalled();
    expect(cmd.iosDelete).not.toHaveBeenCalled();
  });

  test('xcode-scoped: a tracked non-xcode id is not routed to the xcode deleter', async () => {
    const cmd = newCommand();
    cmd.markCreated(SIM_IOS); // defense-in-depth: even if an ios id were tracked
    await expect(cmd.cleanup(SIM_IOS)).resolves.toBe(false);
    expect(cmd.xcodeDelete).not.toHaveBeenCalled();
    expect(cmd.iosDelete).not.toHaveBeenCalled();
  });

  test('best-effort: a failing delete never throws, returns false, and keeps the id', async () => {
    const cmd = newCommand();
    cmd.xcodeDelete.mockRejectedValueOnce(new Error('server unavailable'));
    cmd.markCreated(CREATED_XCODE);

    await expect(cmd.cleanup(CREATED_XCODE)).resolves.toBe(false);
    // Retained so it isn't silently forgotten (matches deleteSim semantics).
    expect(cmd.wasCreated(CREATED_XCODE)).toBe(true);
  });
});
