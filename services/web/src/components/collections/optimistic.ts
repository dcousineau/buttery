import type { CollectionSummary } from "#/lib/api";

/**
 * Pure patches over the cached `CollectionSummary[]` — the optimistic half of
 * the collections feature, and the same shape `components/grocery/optimistic.ts`
 * and `components/plan/optimistic.ts` take for their own routes.
 *
 * Everything here is a pure function of the array the query returned plus the
 * change the member just asked for. Nothing touches the network, React or the
 * router: `mutations.ts` writes the result straight into the query cache and
 * drops it the moment the real payload lands.
 *
 * Nothing is mutated in place — the payload is shared with the query cache, so
 * every patch rebuilds the array and only the collection it touches. Every patch
 * is a no-op for an id the list does not contain, which is what makes React's
 * re-application of a still-pending patch on top of a newer payload harmless.
 *
 * Two invariants every patch preserves, because the server does too (plan §3):
 * `position` is dense `0..n-1` across the list, and `recipeIds` is in entry
 * order — the order the published record's `recipes` array carries.
 *
 * NOT here, on purpose (§6): create, publish, unpublish and delete. Each of
 * those has the server assign something the client cannot guess — a ULID, a
 * PDS-minted rkey, a renumbered list — so they are non-optimistic and simply
 * invalidate.
 */

/** Replace one collection, leaving the list alone when the id is not in it. */
function withCollectionPatched(list: CollectionSummary[], collectionId: string, patch: (collection: CollectionSummary) => CollectionSummary): CollectionSummary[] {
  if (!list.some((collection) => collection.id === collectionId)) return list;
  return list.map((collection) => (collection.id === collectionId ? patch(collection) : collection));
}

/**
 * The order a reorder actually applies, mirroring `reconcileOrder` in
 * `server/collections.ts` exactly: the requested sequence, intersected with what
 * is really there, with anything it failed to mention appended in its existing
 * order.
 *
 * The two copies have to agree or the optimistic list flickers into a different
 * order than the one the invalidation brings back — which is the whole failure
 * an optimistic patch exists to prevent. It is eight lines and it is pure, so it
 * is written twice rather than dragged across the client/server boundary.
 */
function reconcileOrder(present: string[], requested: string[]): string[] {
  const live = new Set(present);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of requested) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const id of present) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

/**
 * Rename a collection and/or rewrite its description.
 *
 * An omitted field is left alone; `description: null` clears it. The server's
 * validator trims, so this trims too — otherwise the name jumps by a space when
 * the real payload arrives.
 */
export function withCollectionEdited(list: CollectionSummary[], collectionId: string, patch: { name?: string; description?: string | null }): CollectionSummary[] {
  return withCollectionPatched(list, collectionId, (collection) => {
    const name = patch.name?.trim();
    const description = patch.description === undefined ? collection.description : (patch.description?.trim() ?? null);
    return {
      ...collection,
      // A blank name is ignored rather than shown: the server rejects it too,
      // and a nameless row is unreadable in the tree.
      name: name ? name : collection.name,
      description: description === "" ? null : description,
    };
  });
}

/**
 * Reorder the household's collection list, restamping `position` so the array
 * and the field cannot disagree while the write is in flight.
 */
export function withCollectionsReordered(list: CollectionSummary[], orderedIds: string[]): CollectionSummary[] {
  const byId = new Map(list.map((collection) => [collection.id, collection]));
  const order = reconcileOrder(
    list.map((collection) => collection.id),
    orderedIds,
  );
  const reordered: CollectionSummary[] = [];
  for (const id of order) {
    const collection = byId.get(id);
    if (collection) reordered.push({ ...collection, position: reordered.length });
  }
  return reordered;
}

/** Reorder the recipes inside one collection — the published array order. */
export function withCollectionRecipesReordered(list: CollectionSummary[], collectionId: string, orderedRecipeIds: string[]): CollectionSummary[] {
  return withCollectionPatched(list, collectionId, (collection) => ({ ...collection, recipeIds: reconcileOrder(collection.recipeIds, orderedRecipeIds) }));
}

/**
 * File recipes into a collection, appended at the bottom in the order given.
 * Already-filed ids are skipped rather than moved, matching the server's
 * `on conflict do nothing` (§8).
 */
export function withRecipesFiled(list: CollectionSummary[], collectionId: string, recipeIds: string[]): CollectionSummary[] {
  return withCollectionPatched(list, collectionId, (collection) => {
    const filed = new Set(collection.recipeIds);
    const fresh: string[] = [];
    for (const id of recipeIds) {
      if (filed.has(id)) continue;
      filed.add(id);
      fresh.push(id);
    }
    return fresh.length === 0 ? collection : { ...collection, recipeIds: collection.recipeIds.concat(fresh) };
  });
}

/** Unfile one recipe from one collection. A no-op when it was never filed. */
export function withRecipeUnfiled(list: CollectionSummary[], collectionId: string, recipeId: string): CollectionSummary[] {
  return withCollectionPatched(list, collectionId, (collection) =>
    collection.recipeIds.includes(recipeId) ? { ...collection, recipeIds: collection.recipeIds.filter((id) => id !== recipeId) } : collection,
  );
}

/**
 * Unfile one recipe from EVERY collection — what removing it from the box does
 * (§2.11), where the server's cascade touches collections the caller never
 * named.
 */
export function withRecipeUnfiledEverywhere(list: CollectionSummary[], recipeId: string): CollectionSummary[] {
  if (!list.some((collection) => collection.recipeIds.includes(recipeId))) return list;
  return list.map((collection) => (collection.recipeIds.includes(recipeId) ? { ...collection, recipeIds: collection.recipeIds.filter((id) => id !== recipeId) } : collection));
}
