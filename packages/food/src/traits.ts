/**
 * @buttery/food/traits — vegan/vegetarian/allergen/tag facts per food (plan
 * `2026-08-20-recipe-enrichment.md` §4.1).
 *
 * **Server-only** (plan D9). `traits.json` exists for the recipe-enrichment
 * pipeline's classifiers (plan §8) — nothing the client renders needs it, and
 * it ships as its own generated file specifically so the client bundle's
 * `lexicon.json` gzip budget stays untouched. `loadTraits()` reaches the JSON
 * through the same dynamic `import()` `categorize.ts` uses for the lexicon,
 * so nothing that never classifies a recipe pulls it into a bundle — but that
 * is a performance property, not the safety one: keep traits reads on the
 * server, the same as any other pipeline-only data.
 */

/** `vegan:en:` / `vegetarian:en:` tri-state, as OFF encodes it: 0 = no, 1 = yes, 2 = maybe. */
export type TriState = 0 | 1 | 2;

/** FDA Big 9 plus gluten (plan D7). */
export type AllergenSlug = "milk" | "egg" | "fish" | "crustacean_shellfish" | "tree_nuts" | "peanut" | "wheat" | "soy" | "sesame" | "gluten";

export const ALLERGEN_SLUGS: readonly AllergenSlug[] = ["milk", "egg", "fish", "crustacean_shellfish", "tree_nuts", "peanut", "wheat", "soy", "sesame", "gluten"];

/**
 * Curated ancestor tags for verdicts §4.1's `{vg, vt, al}` sketch cannot
 * answer on its own: halal/kosher need pork and alcohol, pescatarian needs
 * meat-vs-fish, kosher needs meat/dairy co-occurrence (plan §8.2). See
 * `scripts/food-tags.ts` for why this exists as a fourth trait instead of
 * being hand-rolled inside the diet classifier.
 */
export type FoodTag = "meat" | "pork" | "alcohol" | "seafood";

/** Per-food traits. A key is omitted entirely when the taxonomy says nothing. */
export interface FoodTraits {
  /** Vegan tri-state, nearest-ancestor (a specific override beats a distant default). */
  vg?: TriState;
  /** Vegetarian tri-state, nearest-ancestor. */
  vt?: TriState;
  /** Allergens, accumulated over the whole ancestor closure — a food can carry several. */
  al?: readonly AllergenSlug[];
  /** Tags, accumulated over the whole ancestor closure. */
  tg?: readonly FoodTag[];
}

export interface TraitsFile {
  __meta: Record<string, unknown>;
  foods: Record<string, FoodTraits>;
}

let cached: TraitsFile | null = null;
let loading: Promise<TraitsFile> | null = null;

/**
 * Load `traits.json`, once. Dynamic so the JSON stays out of any bundle that
 * never runs a classifier — the same reasoning as `categorize.ts`'s
 * `loadLexicon`.
 */
export async function loadTraits(): Promise<TraitsFile> {
  if (cached) return cached;
  loading ??= import("./traits.json", { with: { type: "json" } }).then((module) => {
    cached = (module.default ?? module) as unknown as TraitsFile;
    return cached;
  });
  return loading;
}

/** Inject a traits file directly. Tests use this. */
export function setTraits(traits: TraitsFile): void {
  cached = traits;
  loading = Promise.resolve(traits);
}

/**
 * Look up one food's traits against an already-loaded file.
 *
 * Synchronous, so a classifier can resolve every ingredient line of a recipe
 * without an await per line — the same reason `categorizeWith` is synchronous
 * given an already-loaded lexicon. Returns `{}` for a food with no traits (an
 * absent key, not an "unknown" state) or a slug the file has never heard of.
 */
export function traitsFor(traits: TraitsFile, foodSlug: string): FoodTraits {
  return traits.foods[foodSlug] ?? {};
}
