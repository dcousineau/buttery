/**
 * The legal `RecipeImporter.id` values, as data — the one thing the server needs
 * to know about the importer registry without being allowed to import it.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * `recipe_import_session.importer` is free text in the schema and validated at
 * the boundary instead (§5.3), so `openImportSession` needs a Zod enum of the
 * legal ids. The registry that owns those ids —
 * `services/web/src/lib/recipe-import/importers.ts` — imports
 * `@buttery/recipe-extract/paprika`, and the ESLint boundary rule (§2.5, §16.19)
 * forbids `services/web/src/server/recipe-import*` from reaching anything that
 * names an importer. So the *list of ids* lives here, in a module that imports
 * nothing at all, and both sides depend on it:
 *
 *   - the server builds its Zod enum from {@link IMPORTER_IDS};
 *   - the registry types itself as `Record<ImporterId, RecipeImporter>`, so an
 *     importer added to one and not the other is a **type error**, not a 400 the
 *     next person debugs at runtime.
 *
 * Client-safe by construction: no imports, no side effects, string literals only.
 * Adding an importer is one value here plus one entry in the registry.
 */

/** Every shipped importer id. Phase 1: exactly one (§2.5, §17). */
export const IMPORTER_IDS = ["paprika"] as const;

/** The id union. Use it to type the registry so drift is a compile error. */
export type ImporterId = (typeof IMPORTER_IDS)[number];

/** Narrow an untrusted string to a known importer id. */
export function isImporterId(value: unknown): value is ImporterId {
  return typeof value === "string" && (IMPORTER_IDS as readonly string[]).includes(value);
}
