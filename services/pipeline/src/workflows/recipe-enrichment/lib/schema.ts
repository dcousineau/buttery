import { z } from "zod";
import { ALLERGEN_SLUGS, EMITTED_DIET_SLUGS, type AllergenSlug } from "#/workflows/recipe-enrichment/types.ts";

/**
 * What the model is allowed to say, and the version that says which slugs it
 * was asked about (llm plan §7).
 *
 * Two jobs in one file, deliberately:
 *
 *   1. The **closed enums**. Every slug the LLM may emit is listed here and
 *      enforced by zod (L12). A model cannot invent a cuisine any more than a
 *      hostile atproto record can invent an allergen — same reasoning as the
 *      parent plan's D12, and the same consequence if it were not enforced:
 *      `recipe_enrichment_label`'s FK to `recipe_vocab` would reject the write
 *      at the end of a job that already spent a model call, instead of the
 *      schema rejecting it before anything was written.
 *   2. **`LLM_ENRICHMENT_VERSION`** — the LLM's analogue of `CLASSIFIER_VERSION`,
 *      pinned to those sets by `schema.test.ts`. Read `types.ts`'s "TWO VERSION
 *      COLUMNS, NOT ONE" note before changing anything here.
 *
 * Nothing in this file does I/O; `index.ts` is what hands the schema to
 * `generateObject`.
 */

// --- the closed slug sets (L12) -------------------------------------------

/**
 * The 24 cuisines, final for v1 (plan §3.2). Extending this list is a
 * `LLM_ENRICHMENT_VERSION` bump AND a `recipe_vocab` seed migration — the slug
 * has to exist in the vocabulary before a label can reference it, and every
 * recipe classified under the old version has never been asked about the new
 * one.
 */
export const CUISINE_SLUGS = [
  "italian",
  "french",
  "spanish",
  "greek",
  "mexican",
  "tex_mex",
  "american",
  "southern_us",
  "cajun_creole",
  "caribbean",
  "brazilian",
  "peruvian",
  "middle_eastern",
  "turkish",
  "north_african",
  "ethiopian",
  "west_african",
  "indian",
  "thai",
  "vietnamese",
  "chinese",
  "japanese",
  "korean",
  "eastern_european",
] as const;
export type CuisineSlug = (typeof CUISINE_SLUGS)[number];

/** Meal types (plan §3.2). `side` and `drink` are here so "what should I make?" can ask for one. */
export const MEAL_TYPE_SLUGS = ["breakfast", "lunch", "dinner", "dessert", "snack", "side", "drink"] as const;
export type MealTypeSlug = (typeof MEAL_TYPE_SLUGS)[number];

/** Three levels, not five: a model asked to split "medium" from "medium-hot" is being asked to guess. */
export const SPICE_LEVEL_SLUGS = ["mild", "medium", "hot"] as const;
export type SpiceLevelSlug = (typeof SPICE_LEVEL_SLUGS)[number];

/**
 * The six macro/paleo diet slugs the rules classifier has no rule for and
 * deliberately never emits (see `classifiers/README.md`). They already exist in
 * `recipe_vocab` as upstream-aliased, author-declarable tokens — this is the
 * first thing in the codebase to DERIVE them, and it derives them as
 * ingredient-shape guesses, not nutrition math (plan §1.2).
 */
export const LLM_ONLY_DIET_SLUGS = ["keto", "low_carb", "low_fat", "low_calorie", "diabetic", "paleo"] as const;
export type LlmOnlyDietSlug = (typeof LLM_ONLY_DIET_SLUGS)[number];

/**
 * Every diet slug the LLM may judge: the seven the rules emit (so it can give a
 * second opinion on them) plus the six only it can judge.
 */
export const LLM_DIET_SLUGS = [...EMITTED_DIET_SLUGS, ...LLM_ONLY_DIET_SLUGS] as const;
export type LlmDietSlug = (typeof LLM_DIET_SLUGS)[number];

/** The allergen slugs the LLM may judge — the same ten the rules do, no more. */
export const LLM_ALLERGEN_SLUGS = ALLERGEN_SLUGS;

// --- the output schema (plan §7.1) ----------------------------------------

/**
 * `zod` needs a non-empty tuple for `z.enum`; the `as const` arrays above are
 * exactly that, but TypeScript needs the cast spelled out once rather than at
 * four call sites.
 */
const allergenSlug = z.enum([...ALLERGEN_SLUGS] as [AllergenSlug, ...AllergenSlug[]]);
const dietSlug = z.enum([...LLM_DIET_SLUGS] as [LlmDietSlug, ...LlmDietSlug[]]);
const cuisineSlug = z.enum([...CUISINE_SLUGS] as [CuisineSlug, ...CuisineSlug[]]);
const mealTypeSlug = z.enum([...MEAL_TYPE_SLUGS] as [MealTypeSlug, ...MealTypeSlug[]]);
const spiceLevelSlug = z.enum([...SPICE_LEVEL_SLUGS] as [SpiceLevelSlug, ...SpiceLevelSlug[]]);

/**
 * 0..1, rejected outside that range rather than clamped.
 *
 * Clamping would hide the one thing an out-of-range confidence tells you: the
 * model is not answering the question it was asked. `merge.ts` clamps what it
 * WRITES (a defensive floor/ceiling on a value that already validated); this
 * layer refuses.
 */
const confidence = z.number().min(0).max(1);

/**
 * Which ingredient lines justify a judgment, by `recipe_ingredient.ordinal` —
 * the same ordinals the rules' `EvidenceLine`s cite, so a human reading the dev
 * panel sees both providers pointing at the same numbered lines.
 *
 * Not validated against the recipe's actual ordinals here (the schema has never
 * seen the recipe); `index.ts`'s call site resolves them and silently drops any the
 * recipe does not have — a hallucinated line number costs an evidence entry,
 * never a verdict.
 */
const ordinals = z.array(z.number().int()).default([]);

/** Free text from the model explaining a judgment. Kept short by the prompt, capped here. */
const note = z.string().max(500).optional();

export const llmOutputSchema = z.object({
  /**
   * Sparse on the wire (plan §7.1): the model emits only the allergens it has
   * something to say about. An omitted slug means "found nothing", which
   * `merge.ts` turns into no row at all — the same absence-is-a-verdict
   * encoding the rules already use.
   */
  allergens: z
    .array(
      z.object({
        slug: allergenSlug,
        verdict: z.enum(["contains", "may_contain", "not_detected"]),
        confidence,
        ordinals,
        note,
      }),
    )
    .default([]),
  diets: z
    .array(
      z.object({
        slug: dietSlug,
        verdict: z.enum(["excluded", "likely"]),
        confidence,
        ordinals,
        note,
      }),
    )
    .default([]),
  /** At most two — a dish is Tex-Mex or it is Mexican-and-American, never five things. */
  cuisine: z
    .array(z.object({ slug: cuisineSlug, confidence }))
    .max(2)
    .default([]),
  /** At most two — brunch is breakfast and lunch; nothing is four meals. */
  mealType: z
    .array(z.object({ slug: mealTypeSlug, confidence }))
    .max(2)
    .default([]),
  /** `null` for a dish with no meaningful heat, which is most of them. */
  spiceLevel: z.object({ slug: spiceLevelSlug, confidence }).nullable().default(null),
});

/** The validated model output. Every downstream module speaks this, not raw JSON. */
export type LlmOutput = z.infer<typeof llmOutputSchema>;

export type LlmAllergenJudgment = LlmOutput["allergens"][number];
export type LlmDietJudgment = LlmOutput["diets"][number];

// --- the version (plan §7.2, L8) ------------------------------------------

/**
 * Bumped whenever any emitted slug set above or the schema's SHAPE changes.
 *
 * Deliberately NOT bumped for prompt wording (L8): the prompt lives in PostHog
 * and is iterated there, and a wording change that made every recipe
 * backfill-eligible would turn a five-minute experiment into a corpus re-run.
 * When a prompt change IS worth re-running the corpus, that is a deliberate
 * `POST /jobs/recipe-enrichment {"name":"llm-backfill","data":{"force":true}}`,
 * chosen by a person.
 *
 * Stored on `recipe_enrichment.llm_version`, and it is what makes absence
 * readable for the LLM-only dimensions — see `types.ts`'s "TWO VERSION COLUMNS"
 * note. `schema.test.ts` pins the slug sets to this number.
 */
export const LLM_ENRICHMENT_VERSION = 1;

/**
 * The `method` every LLM-written label carries: `llm:<provider>:<model>@vN`
 * (L9). Three things live in one string on purpose — `writeLlmEnrichment`
 * deletes by `method like 'llm:%'`, so the prefix is load-bearing, and the
 * provider/model/version tail is what makes "which model said this?" a question
 * the dev panel can answer from the row alone.
 *
 * The rules' equivalent is `RULES_METHOD` in `lib/classifiers/shared.ts`; the two
 * never collide because nothing rules-derived starts with `llm:`.
 */
export function llmMethod(provider: string, model: string): string {
  return `llm:${provider}:${model}@v${LLM_ENRICHMENT_VERSION}`;
}

/** The prefix `writeLlmEnrichment`'s delete and every "is this row the LLM's?" check match on. */
export const LLM_METHOD_PREFIX = "llm:";
