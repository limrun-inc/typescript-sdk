import { deleteCreatedXcodeInstance, isXcodeInstanceId } from '../packages/cli/src/lib/instance-cleanup';

/**
 * Pins the instance-leak guard: `lim xcode rbe` must delete a server-side
 * instance it auto-created and then abandons (e.g. one that turns out not to
 * support RBE), but never delete a user `--id`, a pre-existing cached instance,
 * or a non-xcode instance. The decision is the pure `deleteCreatedXcodeInstance`
 * policy; BaseCommand only supplies its created-id Set and the SDK delete call.
 */

const CREATED_XCODE = 'sandbox_euna_01created';
const USER_XCODE = 'sandbox_user_01pinned';
const SIM_IOS = 'ios_sim_01attached';

describe('rbe instance-leak cleanup policy', () => {
  test('deletes an xcode instance we created, and is idempotent', async () => {
    const created = new Set([CREATED_XCODE]);
    const del = jest.fn(async () => {});

    await expect(deleteCreatedXcodeInstance(created, CREATED_XCODE, del)).resolves.toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(CREATED_XCODE);
    expect(created.has(CREATED_XCODE)).toBe(false);

    // Dropped from the set on success, so a second attempt is a no-op.
    await expect(deleteCreatedXcodeInstance(created, CREATED_XCODE, del)).resolves.toBe(false);
    expect(del).toHaveBeenCalledTimes(1);
  });

  test('never deletes an id we did not create (user --id / pre-existing / undefined)', async () => {
    const created = new Set<string>(); // nothing created this run
    const del = jest.fn(async () => {});

    for (const id of [USER_XCODE, SIM_IOS, undefined]) {
      await expect(deleteCreatedXcodeInstance(created, id, del)).resolves.toBe(false);
    }
    expect(del).not.toHaveBeenCalled();
  });

  test('xcode-scoped: a tracked non-xcode id is not deleted', async () => {
    const created = new Set([SIM_IOS]); // defense-in-depth: even if tracked
    const del = jest.fn(async () => {});

    await expect(deleteCreatedXcodeInstance(created, SIM_IOS, del)).resolves.toBe(false);
    expect(del).not.toHaveBeenCalled();
    expect(isXcodeInstanceId(SIM_IOS)).toBe(false);
    expect(isXcodeInstanceId('xcode_x_1')).toBe(true);
    expect(isXcodeInstanceId('sandbox_x_1')).toBe(true);
  });

  test('best-effort: a failing delete never throws, returns false, and keeps the id', async () => {
    const created = new Set([CREATED_XCODE]);
    const del = jest.fn(async () => {
      throw new Error('server unavailable');
    });

    await expect(deleteCreatedXcodeInstance(created, CREATED_XCODE, del)).resolves.toBe(false);
    // Retained so it isn't silently forgotten (matches deleteSim semantics).
    expect(created.has(CREATED_XCODE)).toBe(true);
  });
});
