import type { ClassifierLine, Dimension, Evidence, EvidenceLine, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * Small pieces every classifier needs, factored out here (rather than
 * duplicated in `allergen.ts` and `diet.ts`, or hung off `classify.ts`) so
 * `classify.ts` can import `RULES_METHOD` without importing the classifier
 * array itself — `classify.ts` -> `lib/classifiers/index.ts` -> `allergen.ts` /
 * `diet.ts` -> `lib/classifiers/shared.ts` is a straight line, never a cycle.
 */

/** The `method` every rules-derived label carries (plan §3.2). */
export const RULES_METHOD = "rules@1";

/**
 * "A meaningful share of lines did not resolve" (plan §8.1), as one constant.
 * One third: two-of-three lines resolving is still enough of the recipe to
 * reason about; once a third or more of the lines are opaque to the lexicon,
 * a verdict would be guessing more than reading. Used in exactly two places —
 * `allergen.ts`'s confidence tier for `unknown`, and `diet.ts`'s gate between
 * `likely` and `unknown` — never inlined as a magic number anywhere else.
 */
export const MEANINGFUL_UNRESOLVED_SHARE = 1 / 3;

/** Share of lines the lexicon did not resolve (`foodSlug === null`). A recipe with zero lines counts as fully unresolved — there is nothing to reason from. */
export function unresolvedShare(lines: readonly ClassifierLine[]): number {
  if (lines.length === 0) return 1;
  const unresolved = lines.filter((line) => line.foodSlug === null).length;
  return unresolved / lines.length;
}

/** Build a word-boundary, case-insensitive regex from a literal phrase. Escapes regex metacharacters so a phrase containing one (none of ours do today) can't be misread as a pattern. */
export function wordBoundary(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/** One `ClassifierLine` reduced to what `Evidence` cites. */
export function evidenceLine(line: ClassifierLine): EvidenceLine {
  return { ordinal: line.ordinal, text: line.text, foodSlug: line.foodSlug };
}

/** Assemble one `Label`. Every classifier goes through this so `method` and the evidence shape can't drift between `allergen.ts` and `diet.ts`. */
export function makeLabel(dimension: Dimension, slug: string, verdict: Label["verdict"], confidence: number, rule: string, lines: readonly ClassifierLine[], note?: string): Label {
  const evidence: Evidence = { rule, lines: lines.map(evidenceLine) };
  if (note !== undefined) evidence.note = note;
  return { dimension, slug, verdict, confidence, method: RULES_METHOD, evidence };
}
