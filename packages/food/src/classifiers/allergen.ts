import type { AllergenSlug } from "../traits.ts";
import { ALLERGEN_SLUGS } from "../traits.ts";
import type { Classifier, ClassifierLine, Label } from "./types.ts";
import { makeLabel, MEANINGFUL_UNRESOLVED_SHARE, unresolvedShare, wordBoundary } from "./shared.ts";

/**
 * FDA Big 9 plus gluten (plan D7, §8.1).
 *
 * ── `not_detected` IS NOT A SAFETY CLAIM (plan §3.2) ───────────────────────
 * It means the rules found nothing, over free text they may not have fully
 * parsed. A consumer excludes a recipe on `contains` and `may_contain`;
 * nothing in this codebase may present `not_detected` as "free of". The same
 * sentence is in the migration and at the top of `types.ts`, and it is the
 * single most important line in this plan.
 *
 * `not_detected` is also the allergen dimension's default (`types.ts`'s
 * sparse-labels note), so `classifyOne` below never writes a row for it —
 * `every line resolved and none carried this allergen` returns `null`, not a
 * label. The verdict still exists conceptually (this doc keeps discussing it
 * below), it is just never the reason a `recipe_enrichment_label` row exists.
 *

 * ── Confidence ──────────────────────────────────────────────────────────
 * CONF_CONTAINS            lexicon-confirmed: the matched food's own traits
 *                           carry this allergen.
 * CONF_MAY_CONTAIN_STRONG  an unresolved line named a specific dish that is
 *                           that allergen in the overwhelming common case
 *                           (tahini, panko, seitan…) — high real-world
 *                           confidence, capped below `contains` only because
 *                           it did not come through the lexicon.
 * CONF_MAY_CONTAIN_WEAK    an unresolved line named a specific dish whose
 *                           *identity* is certain but whose allergen content
 *                           is not (soy sauce is definitely soy sauce; it is
 *                           only sometimes wheat, since tamari exists).
 * CONF_MAY_CONTAIN_CARRIER an unresolved line named a generic carrier
 *                           ("stock", "sauce", "may contain") where neither
 *                           the dish nor the allergen is pinned down — the
 *                           weakest of the three `may_contain` tiers.
 * CONF_UNKNOWN_PARTIAL     some lines unresolved, below
 *                           `MEANINGFUL_UNRESOLVED_SHARE` — a small gap, not
 *                           a blind guess.
 * CONF_UNKNOWN_LOW         unresolved share at/above that threshold — too
 *                           much of the recipe is opaque to say anything.
 *
 * ── Reconciling `not_detected`'s absolute rule with the "meaningful share"
 *    threshold ─────────────────────────────────────────────────────────
 * Plan §8.1 says `not_detected` fires "only when every line resolved... and
 * none carried it. Nothing else may produce this verdict" — repeated as an
 * absolute in D5, §3.2 and `types.ts`. It also says `unknown` fires when "a
 * meaningful share of lines did not resolve", naming a threshold. Read
 * together, the threshold cannot be what decides `unknown` vs `not_detected`
 * — that split is already absolute on "every line" vs "not every line" — so
 * here it tiers *confidence within* `unknown` instead: a recipe with one
 * exotic unresolved line is a smaller gap than one where most lines are
 * opaque, even though both are `unknown`, never `not_detected`, whenever any
 * line is unresolved. `unresolvedShare(...) > 0` is the only test that gates
 * the verdict; `MEANINGFUL_UNRESOLVED_SHARE` only gates which confidence a
 * resulting `unknown` gets. This is a deliberate reading, not an oversight —
 * see the results doc.
 *
 * ── Scope of the text-pattern table ────────────────────────────────────
 * Patterns below cover the plan's named list of lexicon-miss-prone dishes
 * (§8.1) plus the generic ambiguous-carrier terms it also names ("stock",
 * "broth", "sauce", "may contain"). They deliberately do NOT reimplement a
 * full allergen name dictionary ("milk", "egg", "peanut", "shrimp", …) — raw
 * grocery nouns like those are exactly what the lexicon already resolves
 * well, so a redundant text pattern for them would only add false-positive
 * risk (e.g. a bare "milk" pattern firing on unresolved "coconut milk" /
 * "oat milk" lines) for no coverage gain. `sesame` and `nuts?` are the two
 * exceptions, included because they are themselves named as the
 * word-boundary worked example below.
 *
 * ── `carrier` patterns defer to a `named` one on the same line ─────────
 * "Worcestershire sauce" must not *also* trip the generic `sauce` carrier
 * pattern for `wheat` — we already know precisely what the line is, and
 * generic Worcestershire is anchovy- and malt-vinegar-based, not
 * wheat-flour-based. So a `carrier` pattern is skipped for any line that a
 * `named` (`strong` or `weak`) pattern already matched, for *any* slug — not
 * just the slug currently being checked. See `matchTextPatterns`.
 */

// --- confidence -------------------------------------------------------------

const CONF_CONTAINS = 0.95;
const CONF_MAY_CONTAIN_STRONG = 0.65;
const CONF_MAY_CONTAIN_WEAK = 0.45;
const CONF_MAY_CONTAIN_CARRIER = 0.25;
const CONF_UNKNOWN_PARTIAL = 0.4;
const CONF_UNKNOWN_LOW = 0.15;

// --- text-level patterns, keyed by allergen slug ----------------------------

/**
 * Exported (with `TEXT_PATTERNS` and `TextPattern` below) so `diet.ts` can
 * reuse the already-vetted `fish`/`crustacean_shellfish` entries — fish sauce,
 * anchovy paste, Worcestershire, surimi, nam pla, bonito, shrimp paste — for
 * its own unresolved-line pass instead of re-typing those regexes. Diet has
 * no allergen equivalent for land meat, so it still owns a small pattern list
 * of its own for that half.
 */
export type PatternKind = "strong" | "weak" | "carrier";

export interface TextPattern {
  pattern: RegExp;
  /**
   * `strong` = near-certain identification of a specific dish and this
   * allergen. `weak` = a specific dish, certain identity, uncertain whether
   * *this* allergen is the one it carries. `carrier` = a generic word that
   * names neither a specific dish nor a specific allergen; deferred to any
   * `strong`/`weak` match elsewhere on the same line (see module doc).
   */
  kind: PatternKind;
  note: string;
}

const wb = wordBoundary;

/**
 * Almost empty, and deliberately missing "oyster sauce". Oysters are a
 * mollusk, not a crustacean. FDA's "crustacean shellfish" major-allergen
 * category (crab, lobster, shrimp, crayfish) does not include molluscs
 * (oysters, clams, mussels, scallops) — mollusc allergy is real but is not
 * one of the Big 9. Buttery's taxonomy (D7) has no general shellfish/mollusc
 * slug, so there is no correct slug for "oyster sauce" to fire against here;
 * it fires under `wheat`/`gluten` instead (see below), which is what its
 * ingredient list usually earns it. See the report for this as a
 * plan-vs-taxonomy gap. Shrimp, unlike oyster, *is* a true crustacean, so
 * "shrimp paste" (fermented shrimp — belacan/kapi) does belong here.
 */
const CRUSTACEAN_SHELLFISH_PATTERNS: TextPattern[] = [
  { pattern: wb("shrimp paste"), kind: "strong", note: "fermented shrimp — a true crustacean, unlike oyster/mollusc (see above)" },
];

export const TEXT_PATTERNS: Record<AllergenSlug, TextPattern[]> = {
  milk: [
    { pattern: wb("ghee"), kind: "strong", note: "clarified butter; trace milk protein can remain despite the fat separation" },
    { pattern: wb("gravy"), kind: "weak", note: "commercial/restaurant gravy is often cream- or butter-finished" },
    { pattern: wb("pesto"), kind: "weak", note: "traditional pesto includes parmesan; nut-and-dairy-free variants exist" },
  ],
  egg: [],
  fish: [
    { pattern: wb("fish sauce"), kind: "strong", note: "" },
    { pattern: wb("nam pla"), kind: "strong", note: "Thai name for fish sauce" },
    { pattern: wb("anchovy paste"), kind: "strong", note: "" },
    { pattern: wb("worcestershire"), kind: "strong", note: "traditional recipe is anchovy-based" },
    { pattern: wb("surimi"), kind: "strong", note: "processed whitefish shaped to mimic crab — fish, not crustacean shellfish" },
    { pattern: wb("bonito"), kind: "strong", note: "dried bonito flakes (katsuobushi) — a common invisible fish source in dashi" },
  ],
  // See CRUSTACEAN_SHELLFISH_PATTERNS's comment above.
  crustacean_shellfish: CRUSTACEAN_SHELLFISH_PATTERNS,
  tree_nuts: [
    { pattern: wb("marzipan"), kind: "strong", note: "almond paste" },
    { pattern: wb("praline"), kind: "strong", note: "traditionally pecan or almond" },
    { pattern: wb("frangipane"), kind: "strong", note: "almond cream" },
    { pattern: wb("nougat"), kind: "weak", note: "traditionally almond/hazelnut, but nut-free versions exist" },
    { pattern: wb("pesto"), kind: "weak", note: "traditional pesto uses pine nuts (a tree nut); nut-free variants exist" },
    // Bare "nut(s)": the word-boundary worked example (plan task). `\bnuts?\b`
    // requires a non-word boundary on both sides, so it does NOT match inside
    // "nutmeg" (no boundary between "nut" and "meg") or "coconut" (no
    // boundary between "coco" and "nut") — and coconut is correctly excluded
    // here anyway: despite the name, coconut is a drupe, not a tree nut, for
    // FDA allergen-labeling purposes. `classify.test.ts` pins both non-matches.
    { pattern: wb("nuts?"), kind: "weak", note: "generic; does not imply which tree nut" },
  ],
  peanut: [],
  wheat: [
    { pattern: wb("panko"), kind: "strong", note: "breadcrumbs" },
    { pattern: wb("semolina"), kind: "strong", note: "durum wheat" },
    { pattern: wb("couscous"), kind: "strong", note: "made from semolina wheat" },
    { pattern: wb("bulgur"), kind: "strong", note: "cracked wheat" },
    { pattern: wb("seitan"), kind: "strong", note: "wheat gluten" },
    { pattern: wb("soy sauce"), kind: "weak", note: "most soy sauce is wheat-fermented; tamari is the wheat-free exception and text alone can't tell them apart" },
    { pattern: wb("oyster sauce"), kind: "weak", note: "commercial oyster sauce commonly uses a wheat-starch thickener" },
    { pattern: wb("hoisin"), kind: "weak", note: "commonly wheat-thickened" },
    { pattern: wb("stock"), kind: "carrier", note: "commercial stock/bouillon commonly uses a wheat-flour thickener or filler" },
    { pattern: wb("broth"), kind: "carrier", note: "same as stock" },
    { pattern: wb("bouillon"), kind: "carrier", note: "same as stock" },
    { pattern: wb("sauce"), kind: "carrier", note: "generic, unqualified — could be a roux-thickened sauce" },
  ],
  soy: [
    { pattern: wb("soy sauce"), kind: "strong", note: "" },
    { pattern: wb("miso"), kind: "strong", note: "" },
    { pattern: wb("edamame"), kind: "strong", note: "" },
    { pattern: wb("tempeh"), kind: "strong", note: "" },
    { pattern: wb("hoisin"), kind: "strong", note: "soybean paste base" },
    { pattern: wb("stock"), kind: "carrier", note: "commercial stock/bouillon commonly includes soy or hydrolyzed soy protein" },
    { pattern: wb("broth"), kind: "carrier", note: "same as stock" },
    { pattern: wb("bouillon"), kind: "carrier", note: "same as stock" },
  ],
  sesame: [
    { pattern: wb("tahini"), kind: "strong", note: "ground sesame paste" },
    // Bare "sesame": the word-boundary worked example (plan task) — anchored
    // so it never fires on an empty/absent match. See tree_nuts's "nuts?" note.
    { pattern: wb("sesame"), kind: "strong", note: "" },
  ],
  gluten: [
    { pattern: wb("panko"), kind: "strong", note: "" },
    { pattern: wb("semolina"), kind: "strong", note: "" },
    { pattern: wb("couscous"), kind: "strong", note: "" },
    { pattern: wb("bulgur"), kind: "strong", note: "" },
    { pattern: wb("seitan"), kind: "strong", note: "" },
    // Malt is barley, not wheat — gluten, but deliberately absent from the
    // `wheat` list above.
    { pattern: wb("malt"), kind: "strong", note: "barley — gluten, not wheat" },
    { pattern: wb("worcestershire"), kind: "weak", note: "traditional recipe uses malt vinegar (barley)" },
    { pattern: wb("soy sauce"), kind: "weak", note: "see wheat" },
    { pattern: wb("oyster sauce"), kind: "weak", note: "see wheat" },
    { pattern: wb("hoisin"), kind: "weak", note: "see wheat" },
    { pattern: wb("stock"), kind: "carrier", note: "see wheat" },
    { pattern: wb("broth"), kind: "carrier", note: "see wheat" },
    { pattern: wb("bouillon"), kind: "carrier", note: "see wheat" },
  ],
};

// Every allergen carries the same generic "may contain" disclaimer check —
// added once here instead of ten times above. It is a `carrier` pattern like
// the rest: a line that also names a specific dish (e.g. "tahini, may
// contain traces of other nuts") is already covered by that dish's own
// pattern, so the disclaimer only needs to add signal when nothing else did.
for (const slug of ALLERGEN_SLUGS) {
  TEXT_PATTERNS[slug].push({
    pattern: wb("may contain"),
    kind: "carrier",
    note: "line carries an explicit 'may contain' disclaimer; text alone can't say which allergen it means",
  });
}

/**
 * Gelatin is in the plan's required test list (§8.3) but is not itself an
 * FDA Big 9 + gluten allergen — it is typically rendered collagen (pork,
 * beef or fish bone/skin). It is out of scope for this module; it matters
 * for `vegetarian`/`vegan` and is handled in `diet.ts` instead.
 */

// --- matching ----------------------------------------------------------------

function matchContains(lines: readonly ClassifierLine[], slug: AllergenSlug): ClassifierLine[] {
  return lines.filter((line) => line.foodSlug !== null && (line.traits?.al?.includes(slug) ?? false));
}

/** Whether some `strong`/`weak` (i.e. non-`carrier`) pattern, for any slug, already identifies this line's dish. */
function hasNamedMatchElsewhere(line: ClassifierLine): boolean {
  return ALLERGEN_SLUGS.some((slug) => TEXT_PATTERNS[slug].some((p) => p.kind !== "carrier" && p.pattern.test(line.text)));
}

function matchTextPatterns(lines: readonly ClassifierLine[], slug: AllergenSlug): { strong: ClassifierLine[]; weak: ClassifierLine[]; carrier: ClassifierLine[] } {
  const strong: ClassifierLine[] = [];
  const weak: ClassifierLine[] = [];
  const carrier: ClassifierLine[] = [];
  for (const line of lines) {
    // Patterns only apply to lines the lexicon did not resolve (plan §8.1).
    if (line.foodSlug !== null) continue;
    const named = hasNamedMatchElsewhere(line);
    for (const p of TEXT_PATTERNS[slug]) {
      if (p.kind === "carrier" && named) continue; // a specific dish is already identified; the vague fallback would only mislead.
      if (p.pattern.test(line.text)) {
        (p.kind === "strong" ? strong : p.kind === "weak" ? weak : carrier).push(line);
        break; // one hit is enough signal for this line; don't double-count it.
      }
    }
  }
  return { strong, weak, carrier };
}

function classifyOne(slug: AllergenSlug, lines: readonly ClassifierLine[]): Label | null {
  if (lines.length === 0) {
    return makeLabel("allergen", slug, "unknown", CONF_UNKNOWN_LOW, "no-ingredient-lines", [], "recipe has no ingredient lines to classify");
  }

  const containsLines = matchContains(lines, slug);
  if (containsLines.length > 0) {
    return makeLabel("allergen", slug, "contains", CONF_CONTAINS, "lexicon-trait-match", containsLines);
  }

  const { strong, weak, carrier } = matchTextPatterns(lines, slug);
  if (strong.length > 0 || weak.length > 0 || carrier.length > 0) {
    const [hitLines, confidence] = strong.length > 0 ? [strong, CONF_MAY_CONTAIN_STRONG] : weak.length > 0 ? [weak, CONF_MAY_CONTAIN_WEAK] : [carrier, CONF_MAY_CONTAIN_CARRIER];
    return makeLabel("allergen", slug, "may_contain", confidence, "text-pattern-unresolved-line", hitLines);
  }

  const share = unresolvedShare(lines);
  if (share > 0) {
    // Any unresolved line, with no positive signal, is `unknown` — never
    // `not_detected`. See the module doc's "reconciling" note above.
    const confidence = share >= MEANINGFUL_UNRESOLVED_SHARE ? CONF_UNKNOWN_LOW : CONF_UNKNOWN_PARTIAL;
    const unresolvedLines = lines.filter((line) => line.foodSlug === null);
    return makeLabel(
      "allergen",
      slug,
      "unknown",
      confidence,
      "unresolved-coverage",
      unresolvedLines,
      `${unresolvedLines.length}/${lines.length} lines did not resolve to a known food`,
    );
  }

  // Every line resolved, and none of them carried this allergen. This is
  // `not_detected` — the allergen dimension's default (`types.ts`) — so no
  // label is written; a row here would say nothing a missing row doesn't
  // already say.
  return null;
}

export const allergenClassifier: Classifier = (input) => ALLERGEN_SLUGS.map((slug) => classifyOne(slug, input.lines)).filter((label): label is Label => label !== null);
