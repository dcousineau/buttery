/**
 * Persisting the randomizer's filter state to `localStorage` across visits
 * (change 2 of the post-ship follow-ups; see the meal randomizer plan §5.5/
 * §6.3 for the filter shape this operates on).
 *
 * **Pure and dependency-light, like `draw.ts` beside it.** No React, and no
 * direct `localStorage` access — every function here takes and returns plain
 * values, so it is unit-testable without a DOM and without a component. The
 * component half (a hook in `components/randomizer/`) owns the actual
 * `window.localStorage` calls and is the only place that touches the storage
 * API; it calls {@link serializeFilters} before writing and
 * {@link restoreFilters} after reading.
 *
 * **Defensive by construction, not by afterthought.** `restoreFilters` takes
 * whatever the hook read back — which might be `null` (nothing stored yet),
 * a truncated string (a write that got cut off), a blob that isn't valid
 * JSON at all (a corrupted browser profile), a value of the right JSON shape
 * but the wrong field types (a bug elsewhere, or someone poking devtools), or
 * a shape from an older release before this module's fields existed — and in
 * every one of those cases returns a full, valid `RandomizerFilterState`
 * rather than throwing or handing back something half-formed. Each field is
 * validated by *type*, not just checked for presence: a stored
 * `maxCookMinutes: "soon"` is exactly as absent as a missing key, because
 * both fail the `typeof … === "number"` check the same way.
 *
 * **`source` is deliberately never part of this module's read/write
 * surface.** {@link serializeFilters} does not include it in the payload it
 * builds, and {@link restoreFilters} always returns `source: "box"`
 * regardless of what (if anything) a stored blob claims — see its own doc
 * comment for why.
 */

import { defaultFilters, type RandomizerFilterState } from "./draw";

/**
 * Bumped whenever the stored shape changes in a way older code could
 * misread. `restoreFilters` discards (falls back to defaults for) any blob
 * whose `version` does not match exactly, rather than attempting a
 * migration — the filter set is small enough that "reset to defaults once"
 * is a fine cost for a shape change, and it is a lot less code than a
 * migration ladder for a per-browser convenience cache.
 */
export const RANDOMIZER_FILTERS_STORAGE_VERSION = 1;

/**
 * The `localStorage` key for one household's stored filters. Per-household
 * (change 2: "key it per household — two households must not share a filter
 * set") — a multi-household user switching households must not see one
 * household's filters bleed into another's, so the household id is baked
 * into the key rather than there being one shared "randomizer filters" slot.
 */
export function randomizerFiltersStorageKey(householdId: string): string {
  return `buttery:randomizer-filters:${householdId}`;
}

/**
 * The on-disk shape. Every field is optional — a partially-corrupt or
 * partially-old blob still has *some* fields worth keeping — and there is no
 * `source` field at all, by design (see the module doc comment).
 */
export interface PersistedRandomizerFilters {
  version: number;
  collectionIds?: string[];
  favoritesOnly?: boolean;
  cuisine?: string | null;
  maxCookMinutes?: number | null;
  includeUntimed?: boolean;
  ingredient?: string;
  mealType?: string | null;
  diets?: string[];
  avoidAllergens?: string[];
  spiceLevel?: string | null;
  skipRecentDays?: number | null;
}

/**
 * State → the JSON string the hook writes to `localStorage`.
 *
 * Deliberately omits `filters.source` — widening to the public corpus (plan
 * §4.5) is explicit and opt-in every time a household reaches for it;
 * restoring someone into corpus mode on their NEXT visit, just because that
 * is where they happened to leave off last time, would make that widening
 * implicit. Every visit starts in the box, so the field is never written in
 * the first place rather than being written and then ignored on read (a
 * belt the reader would have to trust rather than a fact the payload itself
 * can't contradict).
 */
export function serializeFilters(filters: RandomizerFilterState): string {
  const payload: PersistedRandomizerFilters = {
    version: RANDOMIZER_FILTERS_STORAGE_VERSION,
    collectionIds: filters.collectionIds,
    favoritesOnly: filters.favoritesOnly,
    cuisine: filters.cuisine,
    maxCookMinutes: filters.maxCookMinutes,
    includeUntimed: filters.includeUntimed,
    ingredient: filters.ingredient,
    mealType: filters.mealType,
    diets: filters.diets,
    avoidAllergens: filters.avoidAllergens,
    spiceLevel: filters.spiceLevel,
    skipRecentDays: filters.skipRecentDays,
  };
  return JSON.stringify(payload);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/** A finite number, or `null` — never `NaN`/`Infinity`, which `JSON.parse` cannot itself produce but a hand-edited blob could smuggle in as a huge/odd literal that still parses. */
function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Raw JSON text → the subset of fields that survive validation. Never
 * throws: a `JSON.parse` failure (corrupt or truncated text) and a
 * non-object result (e.g. a stored `"true"` or `"[]"`) both fall back to
 * `{}`, same as a key that was never written.
 *
 * Every field is checked by *type*, not merely by presence — `undefined` and
 * "present but the wrong shape" are treated identically (both are simply
 * left out of the returned object), which is what lets {@link restoreFilters}
 * paper over the gap with {@link defaultFilters} uniformly regardless of
 * which case produced it. A `version` that does not match
 * {@link RANDOMIZER_FILTERS_STORAGE_VERSION} discards the whole blob rather
 * than trying to salvage individual fields from an unknown shape — see the
 * constant's doc comment.
 */
export function parseStoredFilters(raw: string | null | undefined): Partial<RandomizerFilterState> {
  if (raw == null || raw === "") return {};

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};
  const r = candidate as Record<string, unknown>;
  if (r.version !== RANDOMIZER_FILTERS_STORAGE_VERSION) return {};

  const out: Partial<RandomizerFilterState> = {};
  if (isStringArray(r.collectionIds)) out.collectionIds = r.collectionIds;
  if (typeof r.favoritesOnly === "boolean") out.favoritesOnly = r.favoritesOnly;
  if (isNullableString(r.cuisine)) out.cuisine = r.cuisine;
  if (isNullableFiniteNumber(r.maxCookMinutes)) out.maxCookMinutes = r.maxCookMinutes;
  if (typeof r.includeUntimed === "boolean") out.includeUntimed = r.includeUntimed;
  if (typeof r.ingredient === "string") out.ingredient = r.ingredient;
  if (isNullableString(r.mealType)) out.mealType = r.mealType;
  if (isStringArray(r.diets)) out.diets = r.diets;
  if (isStringArray(r.avoidAllergens)) out.avoidAllergens = r.avoidAllergens;
  if (isNullableString(r.spiceLevel)) out.spiceLevel = r.spiceLevel;
  if (isNullableFiniteNumber(r.skipRecentDays)) out.skipRecentDays = r.skipRecentDays;
  return out;
}

/**
 * Raw JSON text (or `null`/`undefined` — a missing key) → a full, valid
 * `RandomizerFilterState`. The one function the hook actually calls on
 * mount.
 *
 * Whatever {@link parseStoredFilters} could not validate — because it was
 * never stored, because the blob was corrupt, or because a field survived
 * from an older release under a name this version no longer reads — is
 * filled in from {@link defaultFilters}, so a field added after someone's
 * last visit comes back as ITS default rather than `undefined` reaching a
 * component that assumed every field is always present.
 *
 * `source` is always `"box"`, never read from the blob (which never has one
 * — see {@link serializeFilters}) and never left to whatever
 * `defaultFilters().source` happens to be today, so this stays correct even
 * if that default ever changed.
 */
export function restoreFilters(raw: string | null | undefined): RandomizerFilterState {
  const stored = parseStoredFilters(raw);
  return { ...defaultFilters(), ...stored, source: "box" };
}
