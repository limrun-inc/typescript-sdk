/**
 * Pure cleanup policy for instances `lim` auto-creates during one invocation,
 * extracted from BaseCommand so it can be unit-tested without the oclif command
 * runtime (which the repo-root tsc/jest can't load). The command tracks the ids
 * it created in a Set and delegates the "should I delete this, and do it safely"
 * decision here.
 */

/** True for an Xcode instance id (xcode_ / sandbox_ prefix). */
export function isXcodeInstanceId(id: string): boolean {
  const prefix = id.split('_')[0];
  return prefix === 'xcode' || prefix === 'sandbox';
}

/**
 * Best-effort delete of an Xcode instance THIS invocation created. Deletes only
 * when `id` is in `created` AND is an Xcode id, so a user `--id`, a pre-existing
 * cached instance, or a non-xcode id is never touched. Drops the id from the set
 * on success (idempotent) and never throws (a failed delete just returns false
 * and keeps the id). Returns whether it deleted.
 */
export async function deleteCreatedXcodeInstance(
  created: Set<string>,
  id: string | undefined,
  deleteXcodeInstance: (id: string) => Promise<void>,
): Promise<boolean> {
  if (!id || !created.has(id) || !isXcodeInstanceId(id)) return false;
  try {
    await deleteXcodeInstance(id);
    created.delete(id);
    return true;
  } catch {
    return false;
  }
}
