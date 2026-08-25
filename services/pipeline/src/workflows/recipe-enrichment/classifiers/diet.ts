import { TRAIT_MAYBE, TRAIT_NO } from "#/workflows/recipe-enrichment/types.ts";
import type { Classifier, ClassifierLine, Label } from "#/workflows/recipe-enrichment/types.ts";
import { makeLabel, MEANINGFUL_UNRESOLVED_SHARE, unresolvedShare, wordBoundary } from "#/workflows/recipe-enrichment/classifiers/shared.ts";
import { TEXT_PATTERNS as ALLERGEN_TEXT_PATTERNS } from "#/workflows/recipe-enrichment/classifiers/allergen.ts";
import type { TextPattern } from "#/workflows/recipe-enrichment/classifiers/allergen.ts";

/**
 * Diet verdicts (plan D6, §8.2). Three-state — `excluded`, `likely`,
 * `unknown` — and there is no "certified" state and never will be from rules.
 *
 * The full `diet` vocabulary seeded by the migration is eleven upstream slugs
 * (`diabetic, gluten_free, halal, keto, kosher, low_calorie, low_carb,
 * low_fat, paleo, vegan, vegetarian`) plus two this plan adds (`pescatarian,
 * dairy_free`) — thirteen total, and every one of them gets a label. A slug
 * with no label and a slug with `unknown` read differently to a consumer of
 * this table, and only the latter is true here.
 *
 * ── Never author-declared data as evidence ─────────────────────────────
 * This module never reads `recipe.suitable_for_diet` (it isn't even on
 * `ClassifierInput` — pure functions don't reach for it as an out-of-band
 * input either). When a declared diet contradicts a derived verdict, both
 * stand; reconciling them is the Randomizer's problem, and it needs both
 * halves to decide (plan D1, §8.3).
 *
 * ── Unresolved-line pass for vegetarian/vegan/pescatarian ──────────────
 * `vg`/`vt`/`tg` only exist on lines the lexicon resolved. Without a
 * text-level pass, a single unresolved "fish sauce" or "lard" line in an
 * otherwise-resolved recipe would fall through to `likely` — the exact wrong
 * answer §8.3's fixture list exists to prevent, and the one a person could
 * act on and be harmed by. `detectAnimalOrigin` below is that pass — it
 * reuses `allergen.ts`'s already-vetted `fish`/`crustacean_shellfish`
 * patterns (fish sauce, nam pla, anchovy paste, Worcestershire, surimi,
 * bonito, shrimp paste) rather than re-typing those regexes, and adds a
 * small `MEAT_PATTERNS` list of its own — land-animal products have no
 * allergen-slug equivalent to borrow from. A `strong` match is conservative
 * on purpose: it goes to `excluded`, never `likely`, and a `weak`/`carrier`
 * match goes to `unknown` rather than being ignored. "We do not know" is a
 * correct answer here; "probably fine" is not.
 *
 * ── Confidence ──────────────────────────────────────────────────────────
 * CONF_EXCLUDED            a resolved trait/tag directly rules the diet out.
 * CONF_EXCLUDED_TEXT_PATTERN a `strong` unresolved-line match rules it out —
 *                           one notch below `CONF_EXCLUDED` for the same
 *                           reason `allergen.ts` caps `may_contain` below
 *                           `contains`: it did not come through the lexicon.
 * CONF_LIKELY              enough of the recipe resolved and nothing excludes
 *                           it. "Likely", never "certified" (D6) — the number
 *                           reflects that a rule over an ingredient list is
 *                           evidence, not proof.
 * CONF_UNKNOWN_COVERAGE    too many unresolved lines (at/above
 *                           `MEANINGFUL_UNRESOLVED_SHARE`) to say more, for
 *                           the five diets that do get a real verdict — also
 *                           used for a `weak`/`carrier` unresolved animal
 *                           match, which is the same kind of "not enough to
 *                           call it either way" gap.
 * CONF_UNKNOWN_STRUCTURAL  halal/kosher's default. Not a coverage problem —
 *                           no rule over an ingredient list can ever
 *                           establish a supervised kitchen, and the schema
 *                           has no state that would let us pretend otherwise
 *                           (D6). Absent an explicit exclusion this is
 *                           *always* `unknown`, regardless of coverage.
 * CONF_UNKNOWN_MACRO       keto/low_carb/low_fat/low_calorie/diabetic/paleo.
 *                           Not a partial signal — a structural "cannot be
 *                           answered from ingredient names alone" (plan §13
 *                           for the first five; see `paleoUnknown` below for
 *                           paleo). Zero, not merely low: there is no rule at
 *                           all here to have partial confidence in.
 */

// --- confidence -------------------------------------------------------------

const CONF_EXCLUDED = 0.9;
const CONF_EXCLUDED_TEXT_PATTERN = 0.75;
const CONF_LIKELY = 0.7;
const CONF_UNKNOWN_COVERAGE = 0.3;
const CONF_UNKNOWN_STRUCTURAL = 0.2;
const CONF_UNKNOWN_MACRO = 0;

// --- unresolved-line animal-origin patterns ---------------------------------

const wb = wordBoundary;

/**
 * Reused from `allergen.ts`, `carrier` entries excluded — that generic "may
 * contain"/"sauce" tier means something allergen-specific ("which allergen?")
 * that doesn't translate to "is this animal-derived at all?", and diet has
 * its own `ANIMAL_CARRIER_PATTERNS` below for that question instead.
 */
const SEAFOOD_PATTERNS: TextPattern[] = [
  ...ALLERGEN_TEXT_PATTERNS.fish.filter((p) => p.kind !== "carrier"),
  ...ALLERGEN_TEXT_PATTERNS.crustacean_shellfish.filter((p) => p.kind !== "carrier"),
  // Oysters are a mollusc, not a crustacean (see allergen.ts) — irrelevant to
  // vegetarian/vegan, which exclude all animal-derived seafood regardless of
  // FDA's allergen categories.
  {
    pattern: wb("oyster sauce"),
    kind: "strong",
    note: "oysters are a mollusc — animal-derived, so not vegetarian/vegan, even though Buttery's allergen taxonomy has no mollusc slug for it",
  },
];

/**
 * Land-animal products. No allergen-slug equivalent to borrow from — meat
 * isn't an FDA major allergen — so this list is diet.ts's own, kept as
 * narrow as the plan's named fixtures (lard) plus a few more specific
 * product names in the same spirit as allergen.ts's scope rule: named
 * dishes/products the lexicon is prone to miss, not a generic noun
 * dictionary ("beef", "chicken") that the lexicon already resolves well.
 */
const MEAT_PATTERNS: TextPattern[] = [
  { pattern: wb("lard"), kind: "strong", note: "rendered pork fat" },
  { pattern: wb("lardons"), kind: "strong", note: "cubed bacon/pork fat" },
  { pattern: wb("bacon"), kind: "strong", note: "" },
  { pattern: wb("pancetta"), kind: "strong", note: "cured pork belly" },
  { pattern: wb("prosciutto"), kind: "strong", note: "cured pork" },
  { pattern: wb("chorizo"), kind: "strong", note: "pork sausage" },
  // Most commercial gelatin is rendered bovine/porcine collagen; some is
  // fish-derived instead. Either way it is not vegetarian, so it is
  // classified as "meat" here as the common-case default rather than split
  // into its own seafood-or-meat branch.
  { pattern: wb("gelatin"), kind: "strong", note: "rendered animal collagen — usually bovine/porcine, sometimes fish" },
];

/**
 * Ambiguous carriers: could be plant-based, could be land-animal, could be
 * seafood — text alone can't tell, so these never exclude, only downgrade
 * `likely` to `unknown`. Shared between the meat and seafood questions
 * because the ambiguity itself is the same ("stock" could be any of the
 * three) regardless of which diet is asking.
 */
const ANIMAL_CARRIER_PATTERNS: TextPattern[] = [
  { pattern: wb("stock"), kind: "carrier", note: "could be vegetable, meat or fish stock; text alone can't tell" },
  { pattern: wb("broth"), kind: "carrier", note: "same as stock" },
  { pattern: wb("bouillon"), kind: "carrier", note: "same as stock" },
  { pattern: wb("gravy"), kind: "carrier", note: "commonly meat-drippings-based, but vegetarian versions exist" },
];

interface AnimalMatch {
  meatStrong: ClassifierLine[];
  meatWeak: ClassifierLine[];
  seafoodStrong: ClassifierLine[];
  seafoodWeak: ClassifierLine[];
  /** Ambiguous between plant/meat/seafood — never excludes, only forces `unknown`. */
  carrier: ClassifierLine[];
}

/** One pass over the lines the lexicon did not resolve — `vg`/`vt`/`tg` already answer this for the resolved ones. Meat is checked before seafood so a line naming both (rare) doesn't get miscounted as seafood-only. */
function detectAnimalOrigin(lines: readonly ClassifierLine[]): AnimalMatch {
  const result: AnimalMatch = { meatStrong: [], meatWeak: [], seafoodStrong: [], seafoodWeak: [], carrier: [] };
  for (const line of lines) {
    if (line.foodSlug !== null) continue;
    let matched = false;
    for (const p of MEAT_PATTERNS) {
      if (p.pattern.test(line.text)) {
        (p.kind === "strong" ? result.meatStrong : result.meatWeak).push(line);
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const p of SEAFOOD_PATTERNS) {
        if (p.pattern.test(line.text)) {
          (p.kind === "strong" ? result.seafoodStrong : result.seafoodWeak).push(line);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      for (const p of ANIMAL_CARRIER_PATTERNS) {
        if (p.pattern.test(line.text)) {
          result.carrier.push(line);
          matched = true;
          break;
        }
      }
    }
  }
  return result;
}

// --- helpers -----------------------------------------------------------------

function hasTag(line: ClassifierLine, tag: string): boolean {
  return line.traits?.tg?.includes(tag) ?? false;
}

function hasAllergen(line: ClassifierLine, slug: string): boolean {
  return line.traits?.al?.includes(slug) ?? false;
}

/** Below `MEANINGFUL_UNRESOLVED_SHARE`, resolved coverage is good enough to assert `likely`; at/above it, the honest answer is `unknown`. */
function coverageOk(lines: readonly ClassifierLine[]): boolean {
  return unresolvedShare(lines) < MEANINGFUL_UNRESOLVED_SHARE;
}

function unknownCoverage(slug: string, lines: readonly ClassifierLine[]): Label {
  const unresolvedLines = lines.filter((line) => line.foodSlug === null);
  return makeLabel(
    "diet",
    slug,
    "unknown",
    CONF_UNKNOWN_COVERAGE,
    "unresolved-coverage",
    unresolvedLines,
    `${unresolvedLines.length}/${lines.length} lines did not resolve to a known food`,
  );
}

// --- vegetarian / vegan: OFF's own vg/vt tri-states, plus the unresolved-line
// animal-origin pass above (plan §4.1, §8.2, and the fix for d-d9cf5451) ----

function classifyVegetarian(lines: readonly ClassifierLine[]): Label {
  const animal = detectAnimalOrigin(lines);
  const resolvedExcluded = lines.filter(
    (line) => line.foodSlug !== null && (line.traits?.vt === TRAIT_NO || hasTag(line, "meat") || hasTag(line, "pork") || hasTag(line, "seafood")),
  );
  const unresolvedExcluded = [...animal.meatStrong, ...animal.seafoodStrong];
  if (resolvedExcluded.length > 0 || unresolvedExcluded.length > 0) {
    const [rule, evidenceLines, confidence] =
      resolvedExcluded.length > 0 ? ["meat-fish-or-vt-no", resolvedExcluded, CONF_EXCLUDED] : ["unresolved-animal-text-pattern", unresolvedExcluded, CONF_EXCLUDED_TEXT_PATTERN];
    return makeLabel("diet", "vegetarian", "excluded", confidence, rule, evidenceLines);
  }
  const weakSignal = [...animal.meatWeak, ...animal.seafoodWeak, ...animal.carrier];
  if (weakSignal.length > 0) {
    return makeLabel(
      "diet",
      "vegetarian",
      "unknown",
      CONF_UNKNOWN_COVERAGE,
      "unresolved-animal-text-pattern-weak",
      weakSignal,
      "an unresolved line plausibly names an animal-derived ingredient; not confident enough to exclude outright, and not confident enough to call this recipe likely vegetarian either",
    );
  }
  if (!coverageOk(lines)) return unknownCoverage("vegetarian", lines);
  const ambiguous = lines.filter((line) => line.traits?.vt === TRAIT_MAYBE);
  if (ambiguous.length > 0)
    return makeLabel(
      "diet",
      "vegetarian",
      "unknown",
      CONF_UNKNOWN_COVERAGE,
      "ambiguous-vt-trait",
      ambiguous,
      "at least one ingredient's vegetarian status is itself ambiguous in the taxonomy",
    );
  return makeLabel("diet", "vegetarian", "likely", CONF_LIKELY, "no-exclusion-found", []);
}

function classifyVegan(lines: readonly ClassifierLine[]): Label {
  const animal = detectAnimalOrigin(lines);
  const resolvedExcluded = lines.filter(
    (line) => line.foodSlug !== null && (line.traits?.vg === TRAIT_NO || hasTag(line, "meat") || hasTag(line, "pork") || hasTag(line, "seafood")),
  );
  const unresolvedExcluded = [...animal.meatStrong, ...animal.seafoodStrong];
  if (resolvedExcluded.length > 0 || unresolvedExcluded.length > 0) {
    const [rule, evidenceLines, confidence] =
      resolvedExcluded.length > 0 ? ["meat-fish-or-vg-no", resolvedExcluded, CONF_EXCLUDED] : ["unresolved-animal-text-pattern", unresolvedExcluded, CONF_EXCLUDED_TEXT_PATTERN];
    return makeLabel("diet", "vegan", "excluded", confidence, rule, evidenceLines);
  }
  const weakSignal = [...animal.meatWeak, ...animal.seafoodWeak, ...animal.carrier];
  if (weakSignal.length > 0) {
    return makeLabel(
      "diet",
      "vegan",
      "unknown",
      CONF_UNKNOWN_COVERAGE,
      "unresolved-animal-text-pattern-weak",
      weakSignal,
      "an unresolved line plausibly names an animal-derived ingredient; not confident enough to exclude outright, and not confident enough to call this recipe likely vegan either",
    );
  }
  if (!coverageOk(lines)) return unknownCoverage("vegan", lines);
  const ambiguous = lines.filter((line) => line.traits?.vg === TRAIT_MAYBE);
  if (ambiguous.length > 0)
    return makeLabel(
      "diet",
      "vegan",
      "unknown",
      CONF_UNKNOWN_COVERAGE,
      "ambiguous-vg-trait",
      ambiguous,
      "at least one ingredient's vegan status is itself ambiguous in the taxonomy",
    );
  return makeLabel("diet", "vegan", "likely", CONF_LIKELY, "no-exclusion-found", []);
}

// --- pescatarian: tell meat from fish via `tg`, plus the same unresolved-line
// pass — a fish/seafood match is compatible, only a meat match excludes -----

function classifyPescatarian(lines: readonly ClassifierLine[]): Label {
  const animal = detectAnimalOrigin(lines);
  const resolvedExcluded = lines.filter((line) => line.foodSlug !== null && (hasTag(line, "meat") || hasTag(line, "pork")));
  if (resolvedExcluded.length > 0 || animal.meatStrong.length > 0) {
    const [rule, evidenceLines, confidence] =
      resolvedExcluded.length > 0 ? ["land-meat-tag", resolvedExcluded, CONF_EXCLUDED] : ["unresolved-animal-text-pattern", animal.meatStrong, CONF_EXCLUDED_TEXT_PATTERN];
    return makeLabel("diet", "pescatarian", "excluded", confidence, rule, evidenceLines);
  }
  // Seafood (strong or weak) is compatible with pescatarian and does not
  // downgrade `likely` — only ambiguity about *land meat* does.
  const weakSignal = [...animal.meatWeak, ...animal.carrier];
  if (weakSignal.length > 0) {
    return makeLabel(
      "diet",
      "pescatarian",
      "unknown",
      CONF_UNKNOWN_COVERAGE,
      "unresolved-animal-text-pattern-weak",
      weakSignal,
      "an unresolved line is ambiguously animal-derived and could be land meat; not confident enough to exclude, and not confident enough to call this recipe likely pescatarian either",
    );
  }
  if (!coverageOk(lines)) return unknownCoverage("pescatarian", lines);
  return makeLabel("diet", "pescatarian", "likely", CONF_LIKELY, "no-exclusion-found", []);
}

// --- dairy_free / gluten_free: fall out of the allergen facts (plan §8.2) --
// Derived straight from `traits.al` — the same trait data `allergen.ts` reads
// for `contains` — not by calling the allergen classifier. That keeps this
// module free of a classifier-to-classifier dependency and answers only what
// the lexicon actually resolved; it does not reach for an unresolved-line
// text-pattern pass the way vegetarian/vegan/pescatarian now do above. See
// the report for this as a scoping decision, distinct from d-d9cf5451: an
// unresolved "ghee" line still won't exclude dairy_free, only allergen/milk.

function classifyDairyFree(lines: readonly ClassifierLine[]): Label {
  const excluded = lines.filter((line) => line.foodSlug !== null && hasAllergen(line, "milk"));
  if (excluded.length > 0) return makeLabel("diet", "dairy_free", "excluded", CONF_EXCLUDED, "allergen-trait-milk", excluded);
  if (!coverageOk(lines)) return unknownCoverage("dairy_free", lines);
  return makeLabel("diet", "dairy_free", "likely", CONF_LIKELY, "no-milk-trait-found", []);
}

function classifyGlutenFree(lines: readonly ClassifierLine[]): Label {
  const excluded = lines.filter((line) => line.foodSlug !== null && (hasAllergen(line, "wheat") || hasAllergen(line, "gluten")));
  if (excluded.length > 0) return makeLabel("diet", "gluten_free", "excluded", CONF_EXCLUDED, "allergen-trait-wheat-or-gluten", excluded);
  if (!coverageOk(lines)) return unknownCoverage("gluten_free", lines);
  return makeLabel("diet", "gluten_free", "likely", CONF_LIKELY, "no-wheat-or-gluten-trait-found", []);
}

// --- halal / kosher: excluded-or-unknown only, never likely (plan D6, §8.2) -
// There is no rule over an ingredient list that establishes a supervised
// kitchen, and the schema has no state that would let us pretend otherwise.
// So absent an explicit exclusion, both are *always* `unknown` — coverage
// never upgrades either one to `likely`.

function classifyHalal(lines: readonly ClassifierLine[]): Label {
  const excluded = lines.filter((line) => line.foodSlug !== null && (hasTag(line, "pork") || hasTag(line, "alcohol")));
  if (excluded.length > 0) return makeLabel("diet", "halal", "excluded", CONF_EXCLUDED, "pork-or-alcohol-tag", excluded);
  return makeLabel(
    "diet",
    "halal",
    "unknown",
    CONF_UNKNOWN_STRUCTURAL,
    "no-rule-can-certify-a-kitchen",
    [],
    "no ingredient-list rule can confirm halal preparation; only exclusion is possible from rules",
  );
}

function classifyKosher(lines: readonly ClassifierLine[]): Label {
  const porkOrAlcohol = lines.filter((line) => line.foodSlug !== null && (hasTag(line, "pork") || hasTag(line, "alcohol")));
  // Buttery's taxonomy only tracks `crustacean_shellfish` (D7) — kosher
  // actually excludes all shellfish, crustacean and mollusc alike, but there
  // is no mollusc slug to check here. See allergen.ts's oyster-sauce note.
  const shellfish = lines.filter((line) => line.foodSlug !== null && hasAllergen(line, "crustacean_shellfish"));
  if (porkOrAlcohol.length > 0 || shellfish.length > 0) {
    return makeLabel("diet", "kosher", "excluded", CONF_EXCLUDED, "pork-alcohol-or-shellfish", [...porkOrAlcohol, ...shellfish]);
  }
  const meat = lines.filter((line) => line.foodSlug !== null && (hasTag(line, "meat") || hasTag(line, "pork")));
  const dairy = lines.filter((line) => line.foodSlug !== null && hasAllergen(line, "milk"));
  if (meat.length > 0 && dairy.length > 0) {
    return makeLabel("diet", "kosher", "excluded", CONF_EXCLUDED, "meat-and-dairy-cooccurrence", [...meat, ...dairy]);
  }
  return makeLabel(
    "diet",
    "kosher",
    "unknown",
    CONF_UNKNOWN_STRUCTURAL,
    "no-rule-can-certify-a-kitchen",
    [],
    "no ingredient-list rule can confirm kosher preparation; only exclusion is possible from rules",
  );
}

// --- macro-dependent diets: always unknown until nutrition exists (§13) ----

const MACRO_SLUGS = ["keto", "low_carb", "low_fat", "low_calorie", "diabetic"] as const;

function macroUnknown(slug: string): Label {
  return makeLabel(
    "diet",
    slug,
    "unknown",
    CONF_UNKNOWN_MACRO,
    "macro-dependent-not-yet-computed",
    [],
    "needs per-ingredient nutrition data (plan §13); not answerable from ingredient names alone",
  );
}

/**
 * `paleo` is the eleventh upstream diet slug. Plan §8.2 does not mention it
 * at all — no rule, no verdict shape, nothing. Emitting `unknown` rather than
 * inventing a rule the plan never specified. Flagged as a plan gap in the
 * report; see also the results doc.
 */
function paleoUnknown(): Label {
  return makeLabel("diet", "paleo", "unknown", CONF_UNKNOWN_MACRO, "not-specified-in-plan", [], "plan §8.2 defines no rule for paleo; emitting unknown rather than inventing one");
}

export const dietClassifier: Classifier = (input) => {
  const { lines } = input;
  return [
    classifyVegetarian(lines),
    classifyVegan(lines),
    classifyPescatarian(lines),
    classifyDairyFree(lines),
    classifyGlutenFree(lines),
    classifyHalal(lines),
    classifyKosher(lines),
    ...MACRO_SLUGS.map((slug) => macroUnknown(slug)),
    paleoUnknown(),
  ];
};
