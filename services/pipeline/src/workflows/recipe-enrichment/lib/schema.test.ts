import { describe, expect, it } from "vitest";
import {
  CUISINE_SLUGS,
  LLM_ALLERGEN_SLUGS,
  LLM_DIET_SLUGS,
  LLM_ENRICHMENT_VERSION,
  LLM_METHOD_PREFIX,
  LLM_ONLY_DIET_SLUGS,
  llmMethod,
  llmOutputSchema,
  MEAL_TYPE_SLUGS,
  SPICE_LEVEL_SLUGS,
} from "#/workflows/recipe-enrichment/lib/schema.ts";

/**
 * Two things, in the order they matter (llm plan §12.1):
 *
 *   1. The **version pin** — the same invariant `classify.test.ts` pins for the
 *      rules half, for the LLM half. Read that file's pin test first; this is
 *      deliberately its twin, down to the custom failure message.
 *   2. The **schema's refusals** — fixture JSON that must be accepted, and the
 *      four shapes that must be rejected. A model that drifts is not a model
 *      that gets to write a label.
 *
 * Everything here is pure: no model, no network, no keys (L11).
 */

/**
 * The pin. If it fails, you (or a PR before you) changed one of the LLM's
 * emitted slug sets or the schema's shape without bumping
 * `LLM_ENRICHMENT_VERSION` in `schema.ts`.
 *
 * Why that matters is `types.ts`'s "TWO VERSION COLUMNS, NOT ONE" note: for the
 * LLM-only dimensions (`cuisine`, `meal_type`, `spice_level`, and the six
 * macro/paleo diets), an absent row means NOTHING unless `llm_version` covered
 * that slug. Add a cuisine without bumping the version and every recipe already
 * classified silently reports "not this cuisine" for a slug nothing ever looked
 * at — the same failure the rules pin exists to prevent, one dimension over.
 *
 * Bump it, then re-run the corpus:
 *   POST /jobs/recipe-enrichment {"name":"llm-backfill"}
 * (a version bump alone makes every row a candidate — `claimLlmBatch` claims
 * `llm_version < current` — so no `force` is needed for this case.)
 *
 * A new cuisine ALSO needs a `recipe_vocab` seed migration before a label can
 * reference it: `recipe_enrichment_label`'s FK to `recipe_vocab` is what turns
 * a forgotten seed into a rolled-back transaction rather than a bad row.
 */
describe("llm_version — emitted slug sets are pinned to it", () => {
  it("fails if any LLM emitted slug set changes without LLM_ENRICHMENT_VERSION changing", () => {
    const snapshot = {
      LLM_ENRICHMENT_VERSION,
      allergenSlugs: [...LLM_ALLERGEN_SLUGS].sort(),
      dietSlugs: [...LLM_DIET_SLUGS].sort(),
      cuisineSlugs: [...CUISINE_SLUGS].sort(),
      mealTypeSlugs: [...MEAL_TYPE_SLUGS].sort(),
      spiceLevels: [...SPICE_LEVEL_SLUGS].sort(),
    };
    expect(
      snapshot,
      'an LLM emitted slug set changed without an LLM_ENRICHMENT_VERSION bump — bump it in llm/schema.ts, add any new slug to recipe_vocab in a migration, and run POST /jobs/recipe-enrichment {"name":"llm-backfill"} so every already-labelled recipe re-evaluates the new set',
    ).toEqual({
      LLM_ENRICHMENT_VERSION: 1,
      allergenSlugs: ["crustacean_shellfish", "egg", "fish", "gluten", "milk", "peanut", "sesame", "soy", "tree_nuts", "wheat"],
      dietSlugs: ["dairy_free", "diabetic", "gluten_free", "halal", "keto", "kosher", "low_calorie", "low_carb", "low_fat", "paleo", "pescatarian", "vegan", "vegetarian"],
      cuisineSlugs: [
        "american",
        "brazilian",
        "caribbean",
        "cajun_creole",
        "chinese",
        "eastern_european",
        "ethiopian",
        "french",
        "greek",
        "indian",
        "italian",
        "japanese",
        "korean",
        "mexican",
        "middle_eastern",
        "north_african",
        "peruvian",
        "southern_us",
        "spanish",
        "tex_mex",
        "thai",
        "turkish",
        "vietnamese",
        "west_african",
      ].sort(),
      mealTypeSlugs: ["breakfast", "dessert", "dinner", "drink", "lunch", "side", "snack"],
      spiceLevels: ["hot", "medium", "mild"],
    });
  });

  it("keeps the LLM's diet set a strict superset of the rules' — a second opinion has to cover what it is second-guessing", () => {
    // The seven the rules emit are second-opinion territory; the six macro/paleo
    // slugs are the LLM's alone. If the rules ever grow a rule for one of the
    // six, THAT is the moment this assertion should be revisited — not silently.
    for (const slug of LLM_ONLY_DIET_SLUGS) expect(LLM_DIET_SLUGS).toContain(slug);
    expect(LLM_DIET_SLUGS.length).toBe(7 + LLM_ONLY_DIET_SLUGS.length);
  });
});

describe("llmMethod — the ownership prefix writeLlmEnrichment deletes by (L9)", () => {
  it("carries provider, model and version, and starts with the prefix the delete matches", () => {
    const method = llmMethod("moonshot", "kimi-k2-0905-preview");
    expect(method).toBe(`llm:moonshot:kimi-k2-0905-preview@v${LLM_ENRICHMENT_VERSION}`);
    // The prefix is load-bearing SQL, not decoration: `delete ... where method
    // like 'llm:%'` is the whole of how two providers own disjoint label sets
    // in one table. A method that stopped starting with it would make the LLM's
    // rows immortal.
    expect(method.startsWith(LLM_METHOD_PREFIX)).toBe(true);
  });

  it("never collides with the rules method", () => {
    expect(llmMethod("moonshot", "kimi-k2-0905-preview").startsWith("rules@")).toBe(false);
    expect("rules@1".startsWith(LLM_METHOD_PREFIX)).toBe(false);
  });
});

// --- fixture JSON: what the schema accepts and what it refuses (§12.1) ------

/** A full, valid output — every field populated, the shape §7.1 describes. */
const VALID_OUTPUT = {
  allergens: [
    { slug: "fish", verdict: "contains", confidence: 0.95, ordinals: [3], note: "fish sauce" },
    { slug: "sesame", verdict: "may_contain", confidence: 0.4, ordinals: [7] },
  ],
  diets: [
    { slug: "vegetarian", verdict: "excluded", confidence: 0.95, ordinals: [3] },
    { slug: "keto", verdict: "likely", confidence: 0.5, ordinals: [1, 2], note: "no starch, mostly fat and protein" },
  ],
  cuisine: [{ slug: "thai", confidence: 0.9 }],
  mealType: [{ slug: "dinner", confidence: 0.8 }],
  spiceLevel: { slug: "medium", confidence: 0.7 },
};

describe("llmOutputSchema — the closed enums are the enforcement, not the prompt (L12)", () => {
  it("accepts a full valid output unchanged", () => {
    const parsed = llmOutputSchema.parse(VALID_OUTPUT);
    expect(parsed.allergens).toHaveLength(2);
    expect(parsed.cuisine[0]).toEqual({ slug: "thai", confidence: 0.9 });
    expect(parsed.spiceLevel).toEqual({ slug: "medium", confidence: 0.7 });
  });

  it("accepts the empty output — a model with nothing to say is a valid answer, not an error", () => {
    const parsed = llmOutputSchema.parse({});
    expect(parsed).toEqual({ allergens: [], diets: [], cuisine: [], mealType: [], spiceLevel: null });
  });

  it("rejects a cuisine slug outside the closed set", () => {
    // The whole point of L12: the model cannot invent a cuisine. Without this,
    // an invented slug reaches recipe_enrichment_label's FK to recipe_vocab and
    // rolls back a transaction at the end of a job that already paid for a
    // model call — the rejection belongs here, before anything was spent.
    const result = llmOutputSchema.safeParse({ ...VALID_OUTPUT, cuisine: [{ slug: "atlantean", confidence: 0.9 }] });
    expect(result.success).toBe(false);
  });

  it("rejects an allergen slug outside the FDA Big 9 + gluten", () => {
    expect(llmOutputSchema.safeParse({ allergens: [{ slug: "mustard", verdict: "contains", confidence: 1, ordinals: [] }] }).success).toBe(false);
  });

  it("rejects an allergen verdict of `unknown` — that is the RULES' verdict for lines they could not read, and a model that read them has no business claiming it", () => {
    expect(llmOutputSchema.safeParse({ allergens: [{ slug: "fish", verdict: "unknown", confidence: 0.5, ordinals: [] }] }).success).toBe(false);
  });

  it("rejects a confidence outside 0..1 rather than clamping it", () => {
    // Clamping would hide the one thing an out-of-range confidence tells you:
    // the model is not answering the question it was asked.
    expect(llmOutputSchema.safeParse({ ...VALID_OUTPUT, cuisine: [{ slug: "thai", confidence: 1.4 }] }).success).toBe(false);
    expect(llmOutputSchema.safeParse({ ...VALID_OUTPUT, cuisine: [{ slug: "thai", confidence: -0.1 }] }).success).toBe(false);
  });

  it("rejects a third cuisine and a third meal type", () => {
    const three = [
      { slug: "thai", confidence: 0.5 },
      { slug: "vietnamese", confidence: 0.4 },
      { slug: "chinese", confidence: 0.3 },
    ];
    expect(llmOutputSchema.safeParse({ ...VALID_OUTPUT, cuisine: three }).success).toBe(false);
    expect(
      llmOutputSchema.safeParse({
        ...VALID_OUTPUT,
        mealType: [
          { slug: "breakfast", confidence: 0.5 },
          { slug: "lunch", confidence: 0.4 },
          { slug: "snack", confidence: 0.3 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects prose-wrapped JSON — the parse boundary is a shape, not a best-effort extraction", () => {
    // What Kimi drooling looks like from here: a string, not an object. The
    // failure is honest and becomes `llm_status='error'` plus an `$ai_is_error`
    // capture carrying the raw text (§7.1), not a silent half-label.
    expect(llmOutputSchema.safeParse('Here is the JSON you asked for:\n```json\n{"allergens":[]}\n```').success).toBe(false);
  });

  it("defaults ordinals to an empty array, so a judgment with no citation is storable but visibly uncited", () => {
    const parsed = llmOutputSchema.parse({ allergens: [{ slug: "milk", verdict: "may_contain", confidence: 0.3 }] });
    expect(parsed.allergens[0].ordinals).toEqual([]);
  });
});
