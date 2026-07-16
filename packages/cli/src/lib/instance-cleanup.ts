/**
 * Pure cleanup policy for instances `lim` auto-creates during one invocation,
 * extracted from BaseCommand so it can be unit-tested without the oclif command
 * runtime (which the repo-root tsc/jest can't load). The command tracks the ids
 * it created in a Set and delegates the "should I delete this, and do it safely"
 * decision here.
 */

/**
 * Best-effort delete of an instance THIS invocation created. Deletes only when
 * `id` is in `created`, so a user `--id` or a pre-existing cached instance is
 * never touched; the caller's `deleteInstance` dispatches on the id prefix to
 * the right resource. Drops the id from the set on success (idempotent) and
 * never throws (a failed delete just returns false and keeps the id). Returns
 * whether it deleted.
 */
export async function deleteCreatedInstance(
  created: Set<string>,
  id: string | undefined,
  deleteInstance: (id: string) => Promise<void>,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  if (!id || !created.has(id)) return false;
  try {
    await deleteInstance(id);
    created.delete(id);
    return true;
  } catch (err) {
    // Swallowing keeps cleanup best-effort, but a delete that always fails
    // (say, an id prefix the dispatcher does not recognize) is a billing
    // leak; give the caller a hook to at least surface it in debug output.
    onError?.(err);
    return false;
  }
}
