/**
 * The seam for recipe tagging / labelling.
 *
 * Those tables are being added on another branch. This module is what the
 * detail view calls, so when they land the wiring is a body swap in one
 * function rather than a new column threaded through a table, a query, a DTO
 * and a component.
 *
 * Until then `loadAnnotations` returns an empty set and the UI renders an
 * explicit "no annotation store wired up yet" panel — deliberately visible
 * rather than hidden, so nobody has to guess whether a recipe has no labels or
 * the feature simply is not connected.
 *
 * **When the tagging tables land**, the change is:
 *
 *   1. Point `loadAnnotations` at them (dynamic `import("#/lib/db")`, same as
 *      every other handler here), returning one `Annotation` per label.
 *   2. Set `ANNOTATIONS_WIRED` to true.
 *
 * Nothing else moves. `AnnotationSet` is keyed by recipe *identity* rather than
 * by local id alone because a network record may have no local row at all — a
 * label applied to `at://did/exchange.recipe.recipe/rkey` has to be findable
 * from the network side of the detail view, not just the local side.
 */

/** Flip to `true` in the same commit that gives `loadAnnotations` a real body. */
export const ANNOTATIONS_WIRED = false;

/** How a recipe is addressed when asking for its annotations. */
export interface AnnotationSubject {
  /** `public.recipe.id`, when a local row exists. */
  recipeId?: string | null;
  /** The atproto record, when one exists. */
  did?: string | null;
  rkey?: string | null;
}

/** One label/tag applied on top of a recipe by the (future) tagging tables. */
export interface Annotation {
  /** Namespace the label came from, e.g. `moderation`, `taxonomy`, `curation`. */
  ns: string;
  /** The label itself. */
  label: string;
  /** Optional payload — a score, a note, a reviewer DID, whatever the table carries. */
  value: string | null;
  /** Who applied it, when known. */
  actor: string | null;
  applied_at: string | null;
}

export interface AnnotationSet {
  /** False while the store is unwired, so the UI can say so plainly. */
  wired: boolean;
  annotations: Annotation[];
}

/**
 * Annotations for one recipe. Never throws and never returns null — an
 * annotation store being absent, empty or broken must not take down the detail
 * view, whose primary job (showing the two records) does not depend on it.
 */
export function loadAnnotations(_subject: AnnotationSubject): Promise<AnnotationSet> {
  if (!ANNOTATIONS_WIRED) {
    return Promise.resolve({ wired: false, annotations: [] });
  }
  // Unreachable until step 2 above. Kept as the shape the real query returns.
  // The signature stays `Promise`-returning (rather than becoming `async` when
  // there is something to await) so the call site never has to change.
  return Promise.resolve({ wired: true, annotations: [] });
}
