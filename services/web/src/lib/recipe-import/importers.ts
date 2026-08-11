import type { RecipeImporter } from "@buttery/recipe-extract/import";
import { paprikaImporter } from "@buttery/recipe-extract/paprika";
import { IMPORTER_IDS, type ImporterId } from "#/lib/recipe-import-ids";

/**
 * The importer registry — **the only module in the app allowed to import an importer**
 * (plan §2.5 / D30, acceptance §16.19).
 *
 * Everything downstream of "here is a list of parsed candidates" speaks `RecipeImporter`
 * and `ImportCandidate` and never names an app: the route, the worker, the state machine,
 * every review component, and every server function reach an importer through
 * `requireImporter(id)` or consume `ImportCandidate` directly. An oxlint
 * `no-restricted-imports` block over those directories enforces it, with this file as the
 * single documented exemption, so a violation fails `pnpm lint` rather than review.
 *
 * Adding Mela is: a new module under `packages/recipe-extract/src/mela/`, its id in
 * `#/lib/recipe-import-ids`, and one line in `REGISTRY`. Nothing else moves. That is the
 * whole point of the seam, and `REGISTRY`'s `Record<ImporterId, RecipeImporter>` annotation
 * is what makes "id with no implementation" a compile error here and only here (§16.23).
 *
 * The id list is deliberately *not* here: `openImportSession` validates the submitted id
 * against a Zod enum of the same list (§5.3) and the boundary rule forbids the server from
 * importing this module, so the ids live in `#/lib/recipe-import-ids`, which imports
 * nothing. Both sides depend on that one list rather than on each other.
 */
const REGISTRY: Record<ImporterId, RecipeImporter> = {
  paprika: paprikaImporter,
};

// The id on the importer and the key it is registered under must agree: the key is what
// the URL, the worker message, and `recipe_import_session.importer` carry, while the value
// is what gets written to the sidecar (§12.5). A mismatch would label a session with one
// importer and parse it with another, silently.
for (const id of IMPORTER_IDS) {
  const importer = REGISTRY[id];
  if (importer.id !== id) {
    throw new Error(`Importer registry key ${JSON.stringify(id)} holds an importer whose id is ${JSON.stringify(importer.id)}.`);
  }
}

/**
 * Phase 1 hard-resolves the importer on entry rather than offering a chooser — a picker with
 * one option is worse than no picker (§9, §17). The route reads this; the second importer
 * turns it into a real screen and deletes this constant.
 */
export const DEFAULT_IMPORTER_ID: ImporterId = "paprika";

/** Every registered importer, in id order. The second importer's chooser reads this (§17). */
export function listImporters(): readonly RecipeImporter[] {
  return IMPORTER_IDS.map((id) => REGISTRY[id]);
}

/** `null` for an id the app does not ship — a stale link, a hand-edited URL. */
export function getImporter(id: string): RecipeImporter | null {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id as ImporterId] : null;
}

/**
 * The worker's entry point into the registry: it is handed an **id** over `postMessage`
 * and resolves it here, because importing a parser directly from a worker entrypoint is
 * how the §2.5 boundary leaks in the one place lint would still be happy.
 *
 * @throws when the id is not registered — a caller-side bug, not a user-facing state.
 */
export function requireImporter(id: string): RecipeImporter {
  const importer = getImporter(id);
  if (!importer) throw new Error(`Unknown importer ${JSON.stringify(id)}. Registered: ${IMPORTER_IDS.join(", ")}.`);
  return importer;
}
