import { labelForSlug } from "#/lib/recipe-vocab";

/**
 * Turning what the enrichment pipeline derived — plus what the recipe's author
 * declared — into the tag strip both recipe surfaces render.
 *
 * Pure and client-safe: no database, no server fn, no React. That is what lets
 * `recipe-tags.test.ts` cover the whole verdict policy as plain assertions, and
 * it is why the policy lives HERE rather than inside the component. There is
 * exactly one place that decides what a label is allowed to say.
 *
 * ── THE SAFETY RULE THIS FILE ENFORCES ──────────────────────────────────────
 *
 * `not_detected`, `unknown`, and an absent row must NEVER reach the UI as
 * "free of" or "safe". Labels are SPARSE — absence is the dimension's default,
 * not a finding — and the classifier only ever read text it may not have fully
 * parsed. See `server/recipe-enrichment.ts`'s module doc, which is the long version.
 *
 * This is enforced structurally rather than by remembering: the only allergen
 * verdicts that produce a tag are `contains` and `may_contain`. There is no
 * branch that can emit a negative allergen claim, so "free of" is not a state
 * this function can construct. A reviewer checking that property only has to
 * read {@link allergenTags}.
 *
 * ── CONFIDENCE IS NOT HERE, AND CANNOT BE ───────────────────────────────────
 *
 * {@link RecipeTagLabel} has no `confidence` field, because the wire type does
 * not carry one. The rules classifier's values are hardcoded tier constants
 * (0.95 / 0.65 / …, `packages/food/src/classifiers/allergen.ts`), not
 * calibrated probabilities — showing them would dress a constant up as a
 * measurement. The column still exists and still earns its keep in the merge's
 * top-2 cuisine tie-break and in disagreement telemetry; it simply never
 * crosses the display boundary, which makes the leak unrepresentable rather
 * than merely absent.
 */

/** The dimensions the pipeline writes. Kept as a union so a new one is a type error here rather than a silently untagged row. */
export type TagDimension = "allergen" | "diet" | "cuisine" | "meal_type" | "spice_level";

/**
 * One enrichment label as it comes off the wire — `server/recipe-enrichment.ts`'s
 * `enrichmentTagLabels` builds these. Deliberately NOT the DB row shape: no
 * confidence (see the module doc), and `evidence` already collapsed to the one
 * string the UI shows.
 */
export interface RecipeTagLabel {
  dimension: TagDimension;
  slug: string;
  verdict: string;
  source: "rules" | "llm";
  /** `evidence.note` — the model's own sentence about why. `null` for rules rows, which have no note. */
  note: string | null;
  /** Full provenance (`rules@2`, `llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1`) for the `title` attribute. */
  method: string;
}

export interface RecipeTag {
  /** Stable React key. Also what dedupe is NOT keyed on — see {@link mergeRecipeTags}. */
  key: string;
  group: "allergen" | "diet" | "cuisine" | "meal" | "spice" | "facet";
  /** Final display copy. The verdict is always IN here, never only in a tooltip. */
  label: string;
  source: "author" | "rules" | "llm";
  /** `warning` ⇒ destructive Badge. Allergens only: nothing else on a recipe is a warning. */
  tone: "warning" | "neutral";
  note: string | null;
  /** `null` for author-declared tags — they have no classifier to attribute. */
  method: string | null;
}

/**
 * Slugs the pipeline emits that `RECIPE_VOCAB` has no label for, or labels
 * differently than a tag should read.
 *
 * `labelForSlug` covers the vocabulary the app itself authors against; the LLM
 * emits a wider closed set (`services/pipeline/.../lib/schema.ts`), and a few
 * of those either aren't in the app's vocabulary at all or want different
 * casing in a tag than in a form dropdown. Everything not listed falls through
 * to `labelForSlug` and then to {@link startCase}, so an unknown FUTURE slug
 * renders as readable text instead of crashing or vanishing.
 */
const SLUG_LABELS: Record<string, string> = {
  tex_mex: "Tex-Mex",
  cajun_creole: "Cajun & Creole",
  southern_us: "Southern US",
  north_african: "North African",
  west_african: "West African",
  eastern_european: "Eastern European",
  middle_eastern: "Middle Eastern",
  dairy_free: "Dairy-free",
  gluten_free: "Gluten-free",
  pescatarian: "Pescatarian",
  low_carb: "Low-carb",
  low_fat: "Low-fat",
  low_calorie: "Low-calorie",
};

/**
 * How an allergen reads inside a sentence — lowercase, and occasionally
 * broader than the slug.
 *
 * `crustacean_shellfish` becomes "shellfish" deliberately: the slug is
 * narrower than the word most people scan for, and a warning that reads
 * broader than the finding is the safe direction to be wrong in. Never the
 * reverse — no entry here may narrow a warning.
 */
const ALLERGEN_NOUNS: Record<string, string> = {
  tree_nuts: "tree nuts",
  crustacean_shellfish: "shellfish",
  peanut: "peanuts",
  soy: "soy",
  milk: "milk",
  egg: "eggs",
  fish: "fish",
  wheat: "wheat",
  sesame: "sesame",
  gluten: "gluten",
};

const SPICE_LABELS: Record<string, string> = {
  mild: "Mild spice",
  medium: "Medium spice",
  hot: "Hot & spicy",
};

/** `tex_mex` → `Tex Mex`. The last resort, so a slug nobody has taught this file about is still readable. */
function startCase(slug: string): string {
  return slug
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Display text for a slug: the local override, then the app vocabulary, then title case. */
function humanize(dimension: TagDimension, slug: string): string {
  const override = SLUG_LABELS[slug];
  if (override) return override;
  // `cuisine` and `diet` are the two dimensions the app's own vocabulary also
  // covers; `meal_type` and `spice_level` are pipeline-only, so there is
  // nothing to look up for them.
  if (dimension === "cuisine") return labelForSlug("cuisine", slug) ?? startCase(slug);
  if (dimension === "diet") return labelForSlug("diet", slug) ?? startCase(slug);
  return startCase(slug);
}

/** The noun an allergen warning is built around. Falls back to the humanized slug, lowercased, so a new allergen still reads as a sentence. */
function allergenNoun(slug: string): string {
  return ALLERGEN_NOUNS[slug] ?? startCase(slug).toLowerCase();
}

/**
 * Allergens — the only group that produces a `warning` tone, and the only one
 * where the verdict changes the wording.
 *
 * `contains` before `may_contain`, each alphabetical within its verdict, so the
 * definite warnings lead. Every other verdict — `not_detected`, `unknown`, and
 * anything a future classifier invents — falls through and produces nothing.
 * That fall-through IS the safety rule (see the module doc); do not turn it
 * into a `default` branch that emits a tag.
 */
function allergenTags(labels: RecipeTagLabel[]): RecipeTag[] {
  const rank = (verdict: string): number => (verdict === "contains" ? 0 : 1);
  return labels
    .filter((label) => label.verdict === "contains" || label.verdict === "may_contain")
    .sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.slug.localeCompare(b.slug))
    .map((label) => ({
      key: `allergen:${label.slug}`,
      group: "allergen" as const,
      label: `${label.verdict === "contains" ? "Contains" : "May contain"} ${allergenNoun(label.slug)}`,
      source: label.source,
      tone: "warning" as const,
      note: label.note,
      method: label.method,
    }));
}

/**
 * Diets — `likely` only.
 *
 * `excluded` and `unknown` are dropped in v1: a negative dietary claim
 * ("not vegetarian") is noise next to what the author declared, and the
 * author's own `suitableForDiet` already stands as the positive statement. If
 * that changes, this is the one function to revisit.
 */
function dietTags(labels: RecipeTagLabel[]): RecipeTag[] {
  return labels
    .filter((label) => label.verdict === "likely")
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((label) => ({
      key: `diet:${label.slug}`,
      group: "diet" as const,
      label: humanize("diet", label.slug),
      source: label.source,
      tone: "neutral" as const,
      note: label.note,
      method: label.method,
    }));
}

/** Cuisine, meal type and spice level: tag-shaped dimensions whose only stored verdict is `likely`, so there is no verdict policy to apply — only wording. */
function descriptiveTags(labels: RecipeTagLabel[], dimension: TagDimension, group: RecipeTag["group"]): RecipeTag[] {
  return labels
    .filter((label) => label.verdict === "likely")
    .map((label) => ({
      key: `${dimension}:${label.slug}`,
      group,
      label: dimension === "spice_level" ? (SPICE_LABELS[label.slug] ?? humanize(dimension, label.slug)) : humanize(dimension, label.slug),
      source: label.source,
      tone: "neutral" as const,
      note: label.note,
      method: label.method,
    }));
}

/** Lowercased and stripped, for the author-wins dedupe. Not a key — just a comparison. */
function normalizeForDedupe(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface MergeRecipeTagsInput {
  /** What the recipe itself declares — the author's own words, never derived. */
  author: {
    cuisine: string | null;
    category?: string | null;
    cookingMethod?: string | null;
    diets: string[];
  };
  /**
   * Enrichment labels off the wire.
   *
   * `null` means this recipe has never been enriched — a real state, distinct
   * from "enriched and found nothing". `undefined` means the payload predates
   * this feature and came out of a stale IndexedDB cache; both render
   * author-only tags, which is why they are handled together rather than
   * distinguished.
   */
  labels: RecipeTagLabel[] | null | undefined;
}

/**
 * Author facets ⊕ enrichment labels → the tag strip, in display order.
 *
 * Order: allergens (the only warnings) → diets → cuisine → meal type → spice →
 * whatever the author declared that nothing derived. Warnings first because a
 * warning that scrolls is a warning that does not work.
 *
 * ── AUTHOR WINS ON COLLISION ────────────────────────────────────────────────
 *
 * When the pipeline derives a cuisine the author already declared, the author's
 * tag is the one that renders — the derived duplicate is dropped, not shown
 * beside it and not shown with an AI icon. Attributing a fact to a model when a
 * person wrote it down is a small lie, and it is the one this dedupe exists to
 * prevent. Comparison is on normalized display text, not slug, because that is
 * the only thing the two sides share: author facets are free text
 * ("Italian"), labels are slugs (`italian`).
 *
 * Known cosmetic miss: an author's "Southern" and a derived `southern_us`
 * ("Southern US") normalize differently and both render. Harmless duplication,
 * not a wrong attribution, and left alone rather than papered over with fuzzy
 * matching that would eventually collapse two genuinely different cuisines.
 */
export function mergeRecipeTags(input: MergeRecipeTagsInput): RecipeTag[] {
  const labels = input.labels ?? [];
  const byDimension = (dimension: TagDimension): RecipeTagLabel[] => labels.filter((label) => label.dimension === dimension);

  const derived: RecipeTag[] = [
    ...allergenTags(byDimension("allergen")),
    ...dietTags(byDimension("diet")),
    ...descriptiveTags(byDimension("cuisine"), "cuisine", "cuisine"),
    ...descriptiveTags(byDimension("meal_type"), "meal_type", "meal"),
    ...descriptiveTags(byDimension("spice_level"), "spice_level", "spice"),
  ];

  // Built first so they win the dedupe below, appended last so they read after
  // the derived ones.
  const authorFacets: RecipeTag[] = [input.author.cuisine, input.author.category, input.author.cookingMethod, ...input.author.diets]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => ({
      key: `author:${value}`,
      group: "facet" as const,
      label: value,
      source: "author" as const,
      tone: "neutral" as const,
      note: null,
      method: null,
    }));

  const claimed = new Set(authorFacets.map((tag) => normalizeForDedupe(tag.label)));
  const out: RecipeTag[] = [];
  for (const tag of derived) {
    const normalized = normalizeForDedupe(tag.label);
    // A warning is never dropped by the dedupe; every other group defers to the
    // author.
    //
    // Be honest about how narrow this is. Dedupe compares NORMALIZED DISPLAY
    // TEXT, so it only fires when an author facet reads literally like an
    // allergen warning — an author whose cuisine or category is the string
    // "Contains milk". The tempting example (author declares "Dairy-free", the
    // classifier finds milk) does NOT reach here at all: "dairyfree" and
    // "containsmilk" do not collide, so both tags render regardless of this
    // branch. That case is handled by the two labels simply being different
    // text, not by this guard.
    //
    // So this has essentially no realistic subject, and it stays anyway,
    // because the two directions are not symmetric: a spurious duplicate tag is
    // cosmetic, and a silently swallowed allergen warning is the failure this
    // whole feature exists to avoid. A guard that costs one comparison and
    // whose absence could drop a warning is worth keeping even unfired.
    if (claimed.has(normalized) && tag.tone !== "warning") continue;
    claimed.add(normalized);
    out.push(tag);
  }

  return [...out, ...authorFacets];
}
