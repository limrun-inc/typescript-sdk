import { deleteCreatedInstance, preexistingInstanceIds } from '../packages/cli/src/lib/instance-cleanup';

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

describe('preexistingInstanceIds (reuseIfExists cleanup gate)', () => {
  async function* listOf(...ids: string[]) {
    for (const id of ids) yield { metadata: { id } };
  }

  test('snapshots ids reuse could return, with the exact label selector', async () => {
    let seenSelector: string | undefined;
    const ids = await preexistingInstanceIds(
      (selector) => {
        seenSelector = selector;
        return listOf('ios_euna_01old');
      },
      { repo: 'demo', agent: 'claude' },
      true,
    );
    expect(seenSelector).toBe('repo=demo,agent=claude');
    expect(ids).toEqual(new Set(['ios_euna_01old']));
  });

  test('reuse cannot match without reuse or labels, so everything the call returns is fresh', async () => {
    const list = jest.fn();
    await expect(preexistingInstanceIds(list, { repo: 'demo' }, false)).resolves.toEqual(new Set());
    await expect(preexistingInstanceIds(list, undefined, true)).resolves.toEqual(new Set());
    await expect(preexistingInstanceIds(list, {}, true)).resolves.toEqual(new Set());
    expect(list).not.toHaveBeenCalled();
  });

  test('a failed list returns null so callers skip the delete instead of guessing', async () => {
    async function* failing(): AsyncIterable<{ metadata: { id: string } }> {
      throw new Error('server unavailable');
      yield { metadata: { id: 'unreachable' } };
    }
    await expect(preexistingInstanceIds(() => failing(), { repo: 'demo' }, true)).resolves.toBeNull();
  });
});
