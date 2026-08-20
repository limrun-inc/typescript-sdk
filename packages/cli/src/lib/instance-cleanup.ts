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
/**
 * The ids `reuseIfExists` could return instead of creating: the instances that
 * already exist with exactly these labels. Callers snapshot this before a
 * create-with-reuse; a returned id outside the set was created by that call,
 * so a failed attach may delete it without ever touching a reused instance.
 * Returns an empty set when reuse cannot match (no reuse or no labels), and
 * null when the list failed and reuse cannot be ruled out (callers skip the
 * delete then; leaking beats destroying a user's instance).
 */
export async function preexistingInstanceIds(
  list: (labelSelector: string) => AsyncIterable<{ metadata: { id: string } }>,
  labels: Record<string, string> | undefined,
  reuseRequested: boolean,
): Promise<Set<string> | null> {
  const ids = new Set<string>();
  if (!reuseRequested || !labels || Object.keys(labels).length === 0) return ids;
  const selector = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  try {
    for await (const instance of list(selector)) ids.add(instance.metadata.id);
  } catch {
    return null;
  }
  return ids;
}

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
