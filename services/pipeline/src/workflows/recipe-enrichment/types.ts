import type { FoodMatch } from "@buttery/food/categorize";

/**
 * The vocabulary this workflow's halves exchange — the job payloads, and the
 * shapes a classifier reads and writes.
 *
 * It lives in a file of its own for the same reason `atproto-sync/types.ts`
 * does: the payloads are JSON in Redis, written by one deployment and possibly
 * read by the next, so they have to stay small and stay stable. The
 * classification shapes are here for a different reason — `classify.ts` and
 * `steps.ts` must agree on them exactly, and neither should have to import the
 * other to find out.
 *
 * ── `not_detected` IS NOT A SAFETY CLAIM (plan §3.2) ───────────────────────
 * It means the rules found nothing, over free text they may not have fully
 * parsed. A consumer excludes a recipe on `contains` and `may_contain`; nothing
 * in this codebase may present `not_detected` as "free of". The same sentence is
 * in the migration and at the top of the classifier module, and it is the single
 * most important line in this plan.
 */

// --- job payloads ----------------------------------------------------------

/**
 * `enrich`'s payload lives in `@buttery/pipeline-contract`, not here: the web
 * app enqueues these too, and a shape only one side can name is the failure that
 * package exists to prevent (plan §5). Re-exported so this folder has one place
 * to look.
 */
export type { EnrichPayload, LlmEnrichPayload } from "@buttery/pipeline-contract";

/** `backfill`'s payload. Every field optional; the step owns the defaults and the cap. */
export interface BackfillPayload {
  /** Recipes to claim this run. Defaults to 500, hard-capped at 5000 (plan §7.2). */
  limit?: number;
  /** Re-classify even when the fingerprint and classifier version already match. */
  force?: boolean;
  /** Claim only `origin='local'` recipes — somebody's own, not the network's. */
  localOnly?: boolean;
}

/**
 * `llm-backfill`'s payload. Same three fields as {@link BackfillPayload} and the
 * same ownership of defaults by the step — a separate interface rather than a
 * reuse because the two claims answer different questions (`classifier_version`
 * vs `llm_version`) and are free to drift.
 */
export interface LlmBackfillPayload {
  /** Recipes to claim this run. Defaults to 500, hard-capped at 5000. */
  limit?: number;
  /**
   * Re-run the LLM pass even when the fingerprint and `llm_version` match — and,
   * unlike the rules backfill, this is also the only way a `skipped` row (the
   * flag said no) is claimed again while the flag is still off.
   */
  force?: boolean;
  /** Claim only `origin='local'` recipes — somebody's own, not the network's. */
  localOnly?: boolean;
}

/** What `backfill` hands its report parent, and what the report folds children into. */
export interface BackfillReportPayload {
  claimed: number;
  /** Candidates still outstanding after this batch, so a second POST is informed. */
  remaining: number;
  force: boolean;
  localOnly: boolean;
}

// --- what a classifier reads ----------------------------------------------

/** Open Food Facts' own tri-state, as `traits.json` encodes it. */
export type TriState = 0 | 1 | 2;
export const TRAIT_NO = 0 satisfies TriState;
export const TRAIT_YES = 1 satisfies TriState;
export const TRAIT_MAYBE = 2 satisfies TriState;

/**
 * One food's derived facts, structurally identical to `@buttery/food/traits`'
 * `FoodTraits`.
 *
 * Declared structurally rather than imported so a classifier depends on the
 * *shape* of a trait rather than on where this deployment happens to get one:
 * a later provider (§8's seam) can synthesize traits for a food the lexicon
 * never resolved without the classifiers noticing.
 */
export interface IngredientTraits {
  /** Vegan. */
  vg?: TriState;
  /** Vegetarian. */
  vt?: TriState;
  /** Allergen slugs this food carries — `AllergenSlug[]`, widened for the seam above. */
  al?: readonly string[];
  /** Coarse tags: `meat`, `pork`, `alcohol`, `seafood`. */
  tg?: readonly string[];
}

/** One `recipe_ingredient` row, parsed and matched. */
export interface ClassifierLine {
  /** `recipe_ingredient.ordinal` — what evidence cites, so "line 7" means something. */
  ordinal: number;
  /** The line as written. */
  text: string;
  /** The food, cleaned of prep clauses — `parse.ts`'s `name`. */
  name: string;
  quantity: number | null;
  unit: string | null;
  /** Open Food Facts id, or `null` when the lexicon did not resolve the line. */
  foodSlug: string | null;
  /** Which cascade step produced the hit. `miss` is the one that matters here. */
  via: FoodMatch["via"];
  /** `null` for an unresolved line, and for a resolved food that carries no traits. */
  traits: IngredientTraits | null;
}

/** Everything a classifier is handed. Pure input — no database, no network. */
export interface ClassifierInput {
  recipeName: string;
  lines: readonly ClassifierLine[];
}

// --- what a classifier writes ---------------------------------------------

/** FDA Big 9 plus gluten (plan D7). `wheat` and `gluten` are distinct — barley is gluten, not wheat. */
export type AllergenSlug = "milk" | "egg" | "fish" | "crustacean_shellfish" | "tree_nuts" | "peanut" | "wheat" | "soy" | "sesame" | "gluten";

export const ALLERGEN_SLUGS: readonly AllergenSlug[] = ["milk", "egg", "fish", "crustacean_shellfish", "tree_nuts", "peanut", "wheat", "soy", "sesame", "gluten"];

/** Four-state (plan D5). Read the `not_detected` note at the top of this file. */
export type AllergenVerdict = "contains" | "may_contain" | "not_detected" | "unknown";

/**
 * ── LABELS ARE SPARSE: ABSENCE IS A VERDICT ─────────────────────────────────
 *
 * A label row is written ONLY when it says something the dimension's default
 * does not. Everything else is absent, and absence is read as the default:
 *
 *   | dimension | absence means  | stored verdicts                   |
 *   | --------- | -------------- | --------------------------------- |
 *   | allergen  | `not_detected` | `contains`, `may_contain`, `unknown` |
 *   | diet      | `not excluded` | `excluded`, `likely`, `unknown`   |
 *
 * Two thirds of the rows under the old dense encoding were `not_detected` or
 * `unknown` — verdicts the Randomizer's exclusion scan never reads. Storing a
 * constant once per recipe per slug is a cost that grows with the corpus and
 * buys nothing, so it is not paid.
 *
 * `unknown` is still STORED for allergens, deliberately. It is the one negative
 * that differs from the default: `not_detected` means the rules read every line
 * and found nothing, `unknown` means they could not read every line. Collapsing
 * both into absence would lose exactly the distinction this feature is careful
 * about, so `unknown` earns its row and `not_detected` does not.
 *
 * ── THE INVARIANT THAT MAKES THIS SAFE ──────────────────────────────────────
 *
 * Absence may be read as the default ONLY for slugs the row's
 * `classifier_version` actually evaluated. Add a slug to either set below
 * without bumping `CLASSIFIER_VERSION`, and every already-classified recipe
 * silently reports the default for a slug nothing ever looked at — turning
 * "never evaluated" into "we checked and found nothing". For an allergen that
 * is the exact failure this whole feature exists to avoid.
 *
 * `classify.ts` pins this with a test: the emitted slug sets are a snapshot,
 * and changing either without changing `CLASSIFIER_VERSION` fails the suite.
 * That test is the invariant — the comment is only its explanation.
 *
 * ── TWO VERSION COLUMNS, NOT ONE (llm plan §3.4) ────────────────────────────
 *
 * A second provider writes into the same table under its own `method` prefix
 * (`llm:<provider>:<model>@vN`, see `llm/merge.ts`), so "which version
 * evaluated this slug" is now a question with two answers, and the right one
 * is chosen by whichever provider owns the slug:
 *
 *   - Slugs the rules emit (`ALLERGEN_SLUGS`, `EMITTED_DIET_SLUGS`): absence
 *     reads as the default when `recipe_enrichment.classifier_version` covered
 *     them, exactly as above. The LLM only ever ADDS to or escalates these; it
 *     never makes an absence mean less than the rules already made it mean.
 *   - Slugs only the LLM emits (`cuisine/*`, `meal_type/*`, `spice_level/*`,
 *     and the six macro/paleo diets rules have no rule for): absence means
 *     NOTHING unless `recipe_enrichment.llm_status = 'ok'` and
 *     `recipe_enrichment.llm_version` covered that slug. A recipe the flag
 *     skipped has no cuisine row and has never been asked about cuisine —
 *     those two states are the same shape in the table and are told apart
 *     only by the `llm_*` columns.
 *
 * `llm/schema.ts` pins the LLM half the same way `classify.ts` pins the rules
 * half: the emitted slug sets are snapshotted against `LLM_ENRICHMENT_VERSION`
 * in `llm/schema.test.ts`, and changing one without the other fails the suite.
 */

/**
 * The diet slugs the classifier actually has a rule for.
 *
 * NOT the same as the `diet` dimension in `recipe_vocab`, which also carries
 * `keto`, `low_carb`, `low_fat`, `low_calorie`, `diabetic` and `paleo`. Those
 * are upstream `exchange.recipe.defs#diet*` tokens with `recipe_vocab_alias`
 * rows; they stay in the vocabulary because `render.ts` resolves them for
 * AUTHOR-DECLARED diets on `recipe.suitable_for_diet`. The classifier simply
 * has nothing true to say about them — see `classifiers/README.md`.
 */
export const EMITTED_DIET_SLUGS = ["vegetarian", "vegan", "pescatarian", "dairy_free", "gluten_free", "halal", "kosher"] as const;

export type EmittedDietSlug = (typeof EMITTED_DIET_SLUGS)[number];

/**
 * Three-state (plan D6). There is no "certified", and there never will be from
 * rules.
 *
 * `halal` and `kosher` emit `excluded` and nothing else. They used to also emit
 * an `unknown` carrying "no rule can certify a kitchen", which is true and is
 * now simply assumed: somebody keeping kosher either keeps a kitchen to spec or
 * does not, and knows they must source certified ingredients either way. A row
 * per recipe restating that told them nothing they did not already know.
 */
export type DietVerdict = "excluded" | "likely" | "unknown";

/**
 * The `recipe_vocab` dimensions a label may be filed under.
 *
 * The first two are exclusion-shaped and shared: rules and the LLM both write
 * them. The last three are tag-shaped, LLM-only, and carry exactly one stored
 * verdict (`likely`) — see `llm/schema.ts` and the check constraint the
 * `llm_recipe_enrichment` migration installs.
 */
export type Dimension = "allergen" | "diet" | "cuisine" | "meal_type" | "spice_level";

/** One ingredient line that made a verdict what it is. */
export interface EvidenceLine {
  ordinal: number;
  text: string;
  foodSlug: string | null;
}

/**
 * Why a verdict says what it says, stored as the label's `evidence` jsonb.
 *
 * This is what makes a wrong verdict diagnosable instead of mysterious — "this
 * recipe is not vegetarian *because line 7 is fish sauce*" (plan §8.3). It is
 * also the whole reason the dev panel is worth building.
 */
export interface Evidence {
  /** Which rule fired, named so it can be found in the source. */
  rule: string;
  /** The lines that fired it. Empty for a verdict reached from their absence. */
  lines: EvidenceLine[];
  /** Free text where the rule alone does not explain the verdict. */
  note?: string;
}

/** One row of `recipe_enrichment_label`. */
export interface Label {
  dimension: Dimension;
  slug: string;
  verdict: AllergenVerdict | DietVerdict;
  /** 0..1. */
  confidence: number;
  /**
   * Per-label, not per-row, so a later LLM provider can overwrite one recipe's
   * `allergen/sesame` while the rules keep owning the rest (plan §3.2).
   */
  method: string;
  evidence: Evidence;
}

/**
 * One place the LLM and the rules reached different verdicts about the same
 * slug, and the rules won.
 *
 * The merge is safety-asymmetric (llm plan L2): the LLM may escalate an
 * allergen and may fill an absence, but it may never talk one down, and it may
 * never overturn a rules `excluded`. Every time it tries, the attempt is thrown
 * away as a label and kept as one of these — captured to PostHog as an
 * `llm_enrichment_disagreement` event, where it becomes the raw feed for the
 * judge evaluations and the goldens dataset (plan §5.4, §5.5).
 *
 * That is the whole loosening path: the policy stays asymmetric until there is
 * enough evidence in these events to say it should not be. Carries no
 * ingredient text — recipe id and origin only, same redaction line as the rest
 * of the capture layer.
 */
export interface Disagreement {
  dimension: Dimension;
  slug: string;
  /** What the rules row said. `null` where the rules had no row and the LLM was refused for another reason. */
  rulesVerdict: string | null;
  /** What the LLM wanted to say instead. */
  llmVerdict: string;
  llmConfidence: number;
}

/**
 * A classifier. Pure: same input, same labels, no database and no network.
 *
 * Adding an LLM later is adding one module to the array in `classifiers/index.ts`
 * — that is the entire seam (plan D2). Nothing is stubbed dead into the graph
 * today.
 */
export type Classifier = (input: ClassifierInput) => Label[];
