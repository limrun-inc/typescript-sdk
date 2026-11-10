// The CLI edits an instance's blocklist one change at a time, while the
// instance API replaces the whole list. These helpers turn a change into the
// list to send. Names compare without case, as the instance stores them lowercase.

/** The list with names appended, skipping names it already holds. */
export function addToBlocklist(current: string[], names: string[]): string[] {
  const held = new Set(current.map((name) => name.toLowerCase()));
  const result = [...current];
  for (const name of names) {
    if (!held.has(name.toLowerCase())) {
      held.add(name.toLowerCase());
      result.push(name);
    }
  }
  return result;
}

/** The list without names; a name it does not hold is ignored. */
export function removeFromBlocklist(current: string[], names: string[]): string[] {
  const removed = new Set(names.map((name) => name.toLowerCase()));
  return current.filter((name) => !removed.has(name.toLowerCase()));
}
