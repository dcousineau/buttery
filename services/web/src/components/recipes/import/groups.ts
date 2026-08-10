import { RAIL_GROUP_IDS, type RailGroupId } from "#/lib/recipe-import/machine.ts";

/**
 * The rail's labels and its one ordering (plan §10.1).
 *
 * The rail is worked top to bottom, so "which group comes next" is a property of the order
 * and not of any screen — the sources footer, the list footer, and the duplicate queue's
 * last card all say "Done · next: …" and must agree about what next is.
 */
export const GROUP_LABELS: Record<RailGroupId, string> = {
  sources: "Need a source",
  maybe: "Maybe duplicates",
  in_box: "Already yours",
  public: "Already public",
  issues: "Needs a fix",
  ready: "Ready to import",
};

/** Lower-case form for mid-sentence use ("Done · next: already yours"). */
export const GROUP_LABELS_INLINE: Record<RailGroupId, string> = {
  sources: "recipes that need a source",
  maybe: "maybe duplicates",
  in_box: "already yours",
  public: "already public",
  issues: "recipes that need a fix",
  ready: "ready to import",
};

/** The next group down the rail, or null at the bottom. */
export function nextGroup(group: RailGroupId): RailGroupId | null {
  const i = RAIL_GROUP_IDS.indexOf(group);
  return i >= 0 && i < RAIL_GROUP_IDS.length - 1 ? RAIL_GROUP_IDS[i + 1] : null;
}

/** "1 recipe" / "12 recipes" — used often enough to be worth not writing twice. */
export function recipeCount(n: number): string {
  return `${n} ${n === 1 ? "recipe" : "recipes"}`;
}
