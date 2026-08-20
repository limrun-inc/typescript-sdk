import { deleteCreatedInstance, wasFreshlyCreated } from '../packages/cli/src/lib/instance-cleanup';

/**
 * Pins the instance-leak guard: a command must delete a server-side instance it
 * auto-created and then abandons (e.g. an `lim xcode rbe` instance that turns
 * out not to support RBE, or an auto-created gradle instance whose retried
 * command fails), but never delete a user `--id` or a pre-existing cached
 * instance. Membership in the created-id Set is the whole gate here; dispatching
 * the delete to the right resource by id prefix is the caller's deleter closure.
 */

const CREATED = 'gradle_euna_01created';
const USER_PINNED = 'sandbox_user_01pinned';

describe('instance-leak cleanup policy', () => {
  test('deletes an instance we created, and is idempotent', async () => {
    const created = new Set([CREATED]);
    const del = jest.fn(async () => {});

    await expect(deleteCreatedInstance(created, CREATED, del)).resolves.toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(CREATED);
    expect(created.has(CREATED)).toBe(false);

    // Dropped from the set on success, so a second attempt is a no-op.
    await expect(deleteCreatedInstance(created, CREATED, del)).resolves.toBe(false);
    expect(del).toHaveBeenCalledTimes(1);
  });

  test('never deletes an id we did not create (user --id / pre-existing / undefined)', async () => {
    const created = new Set<string>(); // nothing created this run
    const del = jest.fn(async () => {});

    for (const id of [USER_PINNED, CREATED, undefined]) {
      await expect(deleteCreatedInstance(created, id, del)).resolves.toBe(false);
    }
    expect(del).not.toHaveBeenCalled();
  });

  test('best-effort: a failing delete never throws, returns false, and keeps the id', async () => {
    const created = new Set([CREATED]);
    const del = jest.fn(async () => {
      throw new Error('server unavailable');
    });

    await expect(deleteCreatedInstance(created, CREATED, del)).resolves.toBe(false);
    // Retained so it isn't silently forgotten (matches deleteSim semantics).
    expect(created.has(CREATED)).toBe(true);
  });
});

describe('wasFreshlyCreated (reuseIfExists cleanup gate)', () => {
  test('an instance created during the call is fresh, even with server clock up to 15s behind', () => {
    const callStart = Date.now();
    expect(wasFreshlyCreated(new Date(callStart + 2_000).toISOString(), callStart)).toBe(true);
    expect(wasFreshlyCreated(new Date(callStart - 14_000).toISOString(), callStart)).toBe(true);
  });

  test('a reused pre-existing instance is not fresh, and bad timestamps never allow a delete', () => {
    const callStart = Date.now();
    expect(wasFreshlyCreated(new Date(callStart - 60_000).toISOString(), callStart)).toBe(false);
    expect(wasFreshlyCreated('not-a-date', callStart)).toBe(false);
  });
});
