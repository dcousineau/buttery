/**
 * The one sentence every "added to the list" toast says.
 *
 * It lives in its own module because three surfaces raise that toast — the list
 * route, the meal planner's "add all N", and the recipe detail pane — and a
 * shopping list that reports "3 added" in one place and "Added 3 items" in
 * another reads like three different features. The merge count is the part
 * worth saying out loud: "2 added, 1 merged" is the moment the consolidation
 * becomes visible, and hiding it makes a merge look like a dropped row.
 */
export function summarizeGroceryAdd(added: number, merged: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (merged > 0) parts.push(`${merged} merged in`);
  // Every selected row was already on the list at the same total — nothing was
  // lost, but saying "0 added" would read like a failure.
  if (!parts.length) return "Nothing new to add — it’s already on the list";
  return `${parts.join(", ")} · shopping list`;
}
