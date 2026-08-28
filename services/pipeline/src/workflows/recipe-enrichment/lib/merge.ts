import type { ClassifierLine, Dimension, Disagreement, Evidence, EvidenceLine, Label } from "#/workflows/recipe-enrichment/types.ts";
import { llmMethod } from "#/workflows/recipe-enrichment/lib/schema.ts";
import type { LlmAllergenJudgment, LlmDietJudgment, LlmOutput } from "#/workflows/recipe-enrichment/lib/schema.ts";

/**
 * Safety-asymmetric merge of the LLM's second opinion into the rules'
 * labels (llm plan §8, L2). Pure: no database, no network, no clock, no
 * randomness — same input, same `{writes, disagreements}`, always. Read
 * `types.ts`'s "TWO VERSION COLUMNS, NOT ONE" note and `lib/classifiers/shared.ts`
 * before touching this file; the shapes here are deliberately the same
 * family as `makeLabel`/`evidenceLine`, just stamped with `llmMethod(...)`
 * instead of `RULES_METHOD`.
 *
 * ── THE POLICY (plan §8's table, verbatim) ──────────────────────────────────
 *
 * | Dimension | Rules row present? | LLM says | Result |
 * | --- | --- | --- | --- |
 * | allergen | none (absence = not_detected) | contains / may_contain | **write** LLM row (escalation) |
 * | allergen | none | not_detected / omitted | nothing |
 * | allergen | `unknown` (rules couldn't read) | contains / may_contain | **write** LLM row, replacing the rules `unknown` row |
 * | allergen | `unknown` | not_detected | **write** LLM row `not_detected` (resolves the unknown; row keeps `method: llm`) |
 * | allergen | `contains` / `may_contain` | anything weaker | rules row stands; **disagreement event** |
 * | allergen | `may_contain` | `contains` | **write** LLM row (escalation) |
 * | diet | `excluded` | anything | rules row stands; disagreement event if LLM says `likely` |
 * | diet | `likely` / `unknown` | `excluded` | **write** LLM row (exclusion is the safe direction) |
 * | diet | `likely` / `unknown` / none | `likely` | **write** LLM row ONLY where rules had `unknown` or nothing |
 * | macro diets, cuisine, meal_type, spice_level | never (rules don't emit) | any | **write** LLM rows (LLM-owned dimensions) |
 *
 * The last row is not a special case of the code below so much as a
 * consequence of it: a macro-diet slug (`LLM_ONLY_DIET_SLUGS`) never has a
 * rules row, so it always falls through {@link mergeDiet}'s "rules row
 * absent" branches, which already write on `excluded` and on `likely`. Same
 * for `cuisine`/`meal_type`/`spice_level` — they are not `diet` or
 * `allergen` at all, so there is no rules row to consult; every judgment the
 * model emits for them is written.
 *
 * ── `writes` IS THE LLM'S ROWS ONLY ──────────────────────────────────────
 *
 * `writeLlmEnrichment` (`lib/load.ts`) deletes every `method like 'llm:%'`
 * row for the recipe and inserts `writes` — the rules rows are never
 * touched by that statement and must never appear in `writes`. A "rules row
 * stands" outcome in the table above means literally nothing is emitted for
 * that slug, not that the rules label is echoed back.
 *
 * ── ⚠ PK COLLISION: A REPLACEMENT WRITE IS NOT A NEW ROW ───────────────────
 *
 * `recipe_enrichment_label`'s primary key is `(recipe_id, dimension, slug)`.
 * Three rows this module emits — an allergen row that resolves or escalates
 * a rules `unknown` (table rows 3–4), and a diet row that excludes where
 * rules had `likely`/`unknown` (table row 2) — target a `(dimension, slug)`
 * pair that the RULES classifier has *already inserted a row for*. Deleting
 * only `method like 'llm:%'` rows (as `writeLlmEnrichment` does, §9.1) does
 * NOT remove that rules row, so a plain `insert` of the LLM's replacement
 * row will hit the same primary key and violate the constraint (23505), on
 * a recipe that legitimately exercises this policy.
 *
 * This module only decides what should exist; it emits the write either
 * way — the policy is the policy regardless of what the inserter can do
 * with it. Making it landable is `writeLlmEnrichment`'s job: its insert
 * needs `on conflict (recipe_id, dimension, slug) do update set verdict =
 * excluded.verdict, confidence = excluded.confidence, method =
 * excluded.method, evidence = excluded.evidence`. Flagged here loudly
 * because `merge.ts` was written before `load.ts`'s LLM half and the two
 * were built in parallel by different agents — see this slice's report.
 *
 * ── EVIDENCE ─────────────────────────────────────────────────────────────
 *
 * Every LLM row's evidence is `{ rule: "llm", lines: <cited ordinals
 * resolved to EvidenceLine>, note?: <composed note> }`. An ordinal the
 * recipe does not actually have is dropped silently, never rejected — the
 * model hallucinating "line 12" on a nine-line recipe costs that one
 * evidence entry, not the verdict it was attached to (schema.ts makes the
 * same call for the same reason). On a row that REPLACES a rules verdict
 * (the PK-collision cases above), the note names the verdict it replaced —
 * composed with the model's own note rather than dropping either.
 *
 * ── CONFIDENCE CLAMPING ──────────────────────────────────────────────────
 *
 * `schema.ts`'s `confidence` already rejects anything outside 0..1 at
 * validation time — a response that fails that check never reaches this
 * module. The clamp here is therefore a defensive floor/ceiling on data
 * that has ALREADY validated, not a substitute for that validation (the
 * same split `schema.ts`'s own doc comment draws): it exists so a future
 * caller that builds an `LlmOutput` by hand (a test, a migration script, a
 * second code path that skips `llmOutputSchema.parse`) cannot silently
 * write a label with confidence 1.4 to a column the rest of the codebase
 * assumes is 0..1.
 *
 * Macro-diet confidences (`LLM_ONLY_DIET_SLUGS`) are NOT re-clamped to the
 * prompt's ≤0.6 ceiling here — deliberately. That ceiling (plan §6.3) is an
 * instruction to the model about how confident an ingredient-shape guess
 * is allowed to sound, not a structural bound on the dimension the way
 * 0..1 is: re-enforcing it in code would let this module silently overrule
 * a model that reasoned its way to legitimate 0.8 confidence on an
 * unambiguous keto recipe (all fat and protein, zero carbs anywhere in the
 * ingredient list), and would hide a systematically over-confident prompt
 * behind a clamp instead of surfacing it. The judge evals (plan §5.4) grade
 * whether the model respects the ceiling; a merge-layer clamp would make
 * that signal invisible. If the evals show the prompt is not holding the
 * line, the fix is the prompt, not a second, contradictory ceiling here.
 *
 * ── DETERMINISTIC ORDERING ───────────────────────────────────────────────
 *
 * `writes` and `disagreements` are sorted (by dimension, then slug) before
 * being returned. The merge itself is already deterministic given
 * deterministic input, but the order the four sub-merges (allergen, diet,
 * cuisine, meal_type, spice_level) are concatenated in is an implementation
 * detail, not a fact about the recipe — sorting means `merge.test.ts` and a
 * `writeLlmEnrichment` diff never have to care which sub-merge ran first.
 */

// --- input/output shapes ----------------------------------------------------

export interface MergeInput {
  /** The rules labels just written for this recipe (what `classify()` returned). */
  rulesLabels: readonly Label[];
  /** The validated model output. */
  llm: LlmOutput;
  /** The recipe's ingredient lines, so cited ordinals resolve to real EvidenceLines. */
  lines: readonly ClassifierLine[];
  provider: string;
  model: string;
}

export interface MergeResult {
  writes: Label[];
  disagreements: Disagreement[];
}

// --- shared helpers -----------------------------------------------------

/**
 * Floor/ceiling on data that already validated — see the module doc's
 * "CONFIDENCE CLAMPING" section for why this exists at all and why it does
 * NOT re-enforce the macro-diet prompt ceiling.
 */
function clampConfidence(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Resolve cited ordinals to real `EvidenceLine`s, dropping any ordinal the
 * recipe does not actually have. Order is the order the model cited them
 * in; duplicates are left as-is (a model citing the same line twice is odd
 * but harmless, and de-duplicating would be inventing a validation rule
 * `schema.ts` doesn't have).
 */
function resolveOrdinals(ordinals: readonly number[], lines: readonly ClassifierLine[]): EvidenceLine[] {
  const byOrdinal = new Map(lines.map((l) => [l.ordinal, l]));
  const resolved: EvidenceLine[] = [];
  for (const ordinal of ordinals) {
    const line = byOrdinal.get(ordinal);
    if (line) resolved.push({ ordinal: line.ordinal, text: line.text, foodSlug: line.foodSlug });
  }
  return resolved;
}

/** Compose the model's own note with a "replaces rules verdict X" note, without losing either. */
function composeNote(modelNote: string | undefined, replacesVerdict: string | undefined): string | undefined {
  const parts: string[] = [];
  if (modelNote) parts.push(modelNote);
  if (replacesVerdict !== undefined) parts.push(`replaces rules verdict "${replacesVerdict}"`);
  return parts.length > 0 ? parts.join(" — ") : undefined;
}

/**
 * Assemble one LLM-authored `Label`. Every write in this module goes
 * through here, mirroring `lib/classifiers/shared.ts`'s `makeLabel` — the two
 * never drift on evidence shape, and `method` is always `llmMethod(...)`,
 * never `RULES_METHOD`.
 */
function makeLlmLabel(
  dimension: Dimension,
  slug: string,
  verdict: Label["verdict"],
  confidence: number,
  ordinals: readonly number[],
  lines: readonly ClassifierLine[],
  method: string,
  modelNote: string | undefined,
  replacesVerdict: string | undefined,
): Label {
  const evidence: Evidence = { rule: "llm", lines: resolveOrdinals(ordinals, lines) };
  const note = composeNote(modelNote, replacesVerdict);
  if (note !== undefined) evidence.note = note;
  return { dimension, slug, verdict, confidence: clampConfidence(confidence), method, evidence };
}

// --- allergen (plan §8 rows 1–6) -----------------------------------------

/**
 * Ordered so a numeric comparison decides "weaker"/"stronger" without a
 * chain of if/else per pair. `unknown` is deliberately absent from this
 * map — it is not a point on the severity axis, it is "the rules couldn't
 * read this", handled as its own branch below.
 */
const ALLERGEN_SEVERITY: Record<"not_detected" | "may_contain" | "contains", number> = {
  not_detected: 0,
  may_contain: 1,
  contains: 2,
};

function mergeAllergens(rulesLabels: readonly Label[], judgments: readonly LlmAllergenJudgment[], lines: readonly ClassifierLine[], method: string): MergeResult {
  const writes: Label[] = [];
  const disagreements: Disagreement[] = [];
  const rulesBySlug = new Map(rulesLabels.filter((l) => l.dimension === "allergen").map((l) => [l.slug, l]));

  for (const judgment of judgments) {
    const rulesRow = rulesBySlug.get(judgment.slug);
    const rulesVerdict = rulesRow?.verdict as "contains" | "may_contain" | "unknown" | undefined;

    if (rulesVerdict === undefined) {
      // Absence reads as `not_detected` (the dimension's default, `types.ts`'s
      // sparse-labels note). The LLM may only escalate off that default, never
      // write a row that just restates it.
      if (judgment.verdict === "contains" || judgment.verdict === "may_contain") {
        writes.push(makeLlmLabel("allergen", judgment.slug, judgment.verdict, judgment.confidence, judgment.ordinals, lines, method, judgment.note, undefined));
      }
      continue;
    }

    if (rulesVerdict === "unknown") {
      // Rules couldn't read enough of the recipe to say. The LLM's verdict —
      // whichever it is — is strictly more information than "unknown", so it
      // always replaces the rules row (this is one of the PK-collision cases
      // the module doc calls out).
      writes.push(makeLlmLabel("allergen", judgment.slug, judgment.verdict, judgment.confidence, judgment.ordinals, lines, method, judgment.note, rulesVerdict));
      continue;
    }

    // rulesVerdict is `contains` or `may_contain` — a real rules verdict the
    // LLM may only escalate, never talk down (L2).
    const rulesSeverity = ALLERGEN_SEVERITY[rulesVerdict];
    const llmSeverity = ALLERGEN_SEVERITY[judgment.verdict];
    if (llmSeverity > rulesSeverity) {
      writes.push(makeLlmLabel("allergen", judgment.slug, judgment.verdict, judgment.confidence, judgment.ordinals, lines, method, judgment.note, undefined));
    } else if (llmSeverity < rulesSeverity) {
      disagreements.push({ dimension: "allergen", slug: judgment.slug, rulesVerdict, llmVerdict: judgment.verdict, llmConfidence: judgment.confidence });
    }
    // Equal severity: the model agrees with the rules row. Nothing to write,
    // nothing to disagree about.
  }

  return { writes, disagreements };
}

// --- diet (plan §8 rows 7–9, and row 10 for the six macro/paleo slugs) ---

function mergeDiet(rulesLabels: readonly Label[], judgments: readonly LlmDietJudgment[], lines: readonly ClassifierLine[], method: string): MergeResult {
  const writes: Label[] = [];
  const disagreements: Disagreement[] = [];
  const rulesBySlug = new Map(rulesLabels.filter((l) => l.dimension === "diet").map((l) => [l.slug, l]));

  for (const judgment of judgments) {
    const rulesRow = rulesBySlug.get(judgment.slug);
    const rulesVerdict = rulesRow?.verdict as "excluded" | "likely" | "unknown" | undefined;

    if (rulesVerdict === "excluded") {
      // The one verdict the LLM may never overturn (L2). Only worth a
      // disagreement event when the model actively contradicts it — agreeing
      // (`excluded`) is not a disagreement.
      if (judgment.verdict === "likely") {
        disagreements.push({ dimension: "diet", slug: judgment.slug, rulesVerdict, llmVerdict: judgment.verdict, llmConfidence: judgment.confidence });
      }
      continue;
    }

    if (judgment.verdict === "excluded") {
      // Exclusion is the safe direction regardless of what the rules row said
      // (`likely`, `unknown`, or nothing — the macro/paleo-diet case, which
      // never has a rules row at all). `rulesVerdict` here is undefined for a
      // slug rules never touched, so `makeLlmLabel` composes no "replaces"
      // note for it — correct, since there is nothing to replace.
      writes.push(makeLlmLabel("diet", judgment.slug, "excluded", judgment.confidence, judgment.ordinals, lines, method, judgment.note, rulesVerdict));
      continue;
    }

    // judgment.verdict === "likely": only worth writing where the rules row
    // said less than "likely" already (`unknown`) or said nothing at all —
    // writing over a rules `likely` with an LLM `likely` would be a byte-for-
    // byte-different row that claims the same thing, for no reader's benefit.
    if (rulesVerdict === undefined || rulesVerdict === "unknown") {
      writes.push(makeLlmLabel("diet", judgment.slug, "likely", judgment.confidence, judgment.ordinals, lines, method, judgment.note, rulesVerdict));
    }
  }

  return { writes, disagreements };
}

// --- cuisine / meal_type (LLM-owned, tag-shaped, capped at 2) -----------

const TAG_CAP = 2;

/**
 * Keep the two (at most) highest-confidence entries. The schema already
 * caps at 2 (`z.array(...).max(2)`) — belt and braces against a hand-built
 * `LlmOutput` that skipped validation.
 */
function capByConfidence<T extends { confidence: number }>(items: readonly T[], cap: number): T[] {
  if (items.length <= cap) return [...items];
  return [...items].sort((a, b) => b.confidence - a.confidence).slice(0, cap);
}

function mergeTagDimension(dimension: Dimension, items: readonly { slug: string; confidence: number }[], lines: readonly ClassifierLine[], method: string): Label[] {
  return capByConfidence(items, TAG_CAP).map((item) => makeLlmLabel(dimension, item.slug, "likely", item.confidence, [], lines, method, undefined, undefined));
}

// --- spice_level (LLM-owned, at most one row) ----------------------------

function mergeSpiceLevel(spiceLevel: LlmOutput["spiceLevel"], lines: readonly ClassifierLine[], method: string): Label[] {
  if (!spiceLevel) return [];
  return [makeLlmLabel("spice_level", spiceLevel.slug, "likely", spiceLevel.confidence, [], lines, method, undefined, undefined)];
}

// --- ordering (module doc's "DETERMINISTIC ORDERING") -------------------

function compareLabel(a: Label, b: Label): number {
  return a.dimension === b.dimension ? a.slug.localeCompare(b.slug) : a.dimension.localeCompare(b.dimension);
}

function compareDisagreement(a: Disagreement, b: Disagreement): number {
  return a.dimension === b.dimension ? a.slug.localeCompare(b.slug) : a.dimension.localeCompare(b.dimension);
}

// --- the entry point ------------------------------------------------------

export function mergeLlmLabels(input: MergeInput): MergeResult {
  const { rulesLabels, llm, lines, provider, model } = input;
  const method = llmMethod(provider, model);

  const allergenResult = mergeAllergens(rulesLabels, llm.allergens, lines, method);
  const dietResult = mergeDiet(rulesLabels, llm.diets, lines, method);
  const cuisineWrites = mergeTagDimension("cuisine", llm.cuisine, lines, method);
  const mealTypeWrites = mergeTagDimension("meal_type", llm.mealType, lines, method);
  const spiceLevelWrites = mergeSpiceLevel(llm.spiceLevel, lines, method);

  const writes = [...allergenResult.writes, ...dietResult.writes, ...cuisineWrites, ...mealTypeWrites, ...spiceLevelWrites].sort(compareLabel);
  const disagreements = [...allergenResult.disagreements, ...dietResult.disagreements].sort(compareDisagreement);

  return { writes, disagreements };
}
