import { describe, expect, it } from "vitest";
import { mergeRecipeTags, type MergeRecipeTagsInput, type RecipeTagLabel } from "./recipe-tags.ts";

/**
 * `mergeRecipeTags` is the one place the verdict policy (recipe-enrichment-tags-ui
 * plan, "Architecture decisions" §6) lives, and the module doc calls that out
 * explicitly: a reviewer checking "can this render a 'free of' claim" only has to
 * read one function. These tests exist to keep that true — the safety-rule case
 * below is the one that matters most in this file.
 */

function author(over: Partial<MergeRecipeTagsInput["author"]> = {}): MergeRecipeTagsInput["author"] {
  return { cuisine: null, diets: [], ...over };
}

function label(over: Partial<RecipeTagLabel>): RecipeTagLabel {
  return { dimension: "allergen", slug: "milk", verdict: "contains", source: "rules", note: null, method: "rules@2", ...over };
}

describe("mergeRecipeTags — no labels yet", () => {
  it("renders author-only tags when labels is null (never enriched)", () => {
    const out = mergeRecipeTags({ author: author({ cuisine: "Italian", diets: ["Vegetarian"] }), labels: null });
    expect(out).toEqual([
      { key: "author:Italian", group: "facet", label: "Italian", source: "author", tone: "neutral", note: null, method: null },
      { key: "author:Vegetarian", group: "facet", label: "Vegetarian", source: "author", tone: "neutral", note: null, method: null },
    ]);
  });

  // `null` and `undefined` are two distinct states on the wire — `null` means
  // this recipe has genuinely never been enriched, `undefined` means the
  // payload came out of a pre-feature IndexedDB cache that predates the
  // `enrichment` field entirely (module doc on `MergeRecipeTagsInput.labels`).
  // They render identically (author-only), but that has to be an explicit
  // choice in the code, not an accident of `??` happening to catch both — so
  // both states get their own assertion here rather than one parametrized case.
  it("renders author-only tags when labels is undefined (pre-feature cached payload), same as null", () => {
    const withNull = mergeRecipeTags({ author: author({ cuisine: "Italian" }), labels: null });
    const withUndefined = mergeRecipeTags({ author: author({ cuisine: "Italian" }), labels: undefined });
    expect(withUndefined).toEqual(withNull);
    expect(withUndefined).toEqual([{ key: "author:Italian", group: "facet", label: "Italian", source: "author", tone: "neutral", note: null, method: null }]);
  });

  it("returns [] when there is nothing to show at all", () => {
    expect(mergeRecipeTags({ author: author(), labels: null })).toEqual([]);
    expect(mergeRecipeTags({ author: author(), labels: [] })).toEqual([]);
  });
});

// ── THE SAFETY RULE ─────────────────────────────────────────────────────────
//
// This is the most important test in this file. `not_detected`, `unknown` (for
// allergens) and `excluded`/`unknown` (for diets) must never produce a tag —
// not a muted one, not a differently-worded one, NONE. A row saying "not
// detected" means the rules read text they may not have fully parsed, not
// that the dish is free of that allergen (recipe-enrichment.ts's module doc,
// "`not_detected` IS NOT A SAFETY CLAIM"). If this test ever fails because a
// tag appeared, that is a constructible "free of" claim reaching the UI and it
// must be treated as a safety regression, not a snapshot to update.
describe("mergeRecipeTags — the safety rule: no 'free of' claim is constructible", () => {
  it("produces no allergen or diet tags at all when every label is a negative/unknown verdict", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "allergen", slug: "milk", verdict: "not_detected" }),
      label({ dimension: "allergen", slug: "peanut", verdict: "unknown" }),
      label({ dimension: "diet", slug: "vegan", verdict: "excluded" }),
      label({ dimension: "diet", slug: "vegetarian", verdict: "unknown" }),
    ];
    const out = mergeRecipeTags({ author: author(), labels });
    expect(out).toEqual([]);
    expect(out.some((tag) => tag.group === "allergen")).toBe(false);
    expect(out.some((tag) => tag.group === "diet")).toBe(false);
  });

  it("drops only the negative/unknown rows, keeping any positive verdicts alongside them", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "allergen", slug: "milk", verdict: "not_detected" }),
      label({ dimension: "allergen", slug: "peanut", verdict: "contains" }),
      label({ dimension: "diet", slug: "vegan", verdict: "unknown" }),
    ];
    const out = mergeRecipeTags({ author: author(), labels });
    expect(out).toEqual([{ key: "allergen:peanut", group: "allergen", label: "Contains peanuts", source: "rules", tone: "warning", note: null, method: "rules@2" }]);
  });
});

describe("mergeRecipeTags — allergen copy and tone", () => {
  it("renders 'contains' as a definite warning", () => {
    const out = mergeRecipeTags({ author: author(), labels: [label({ dimension: "allergen", slug: "milk", verdict: "contains" })] });
    expect(out).toEqual([{ key: "allergen:milk", group: "allergen", label: "Contains milk", source: "rules", tone: "warning", note: null, method: "rules@2" }]);
  });

  it("renders 'may_contain' as a hedged warning, same tone as 'contains'", () => {
    const out = mergeRecipeTags({
      author: author(),
      labels: [label({ dimension: "allergen", slug: "egg", verdict: "may_contain", source: "llm", method: "llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1" })],
    });
    expect(out).toEqual([
      {
        key: "allergen:egg",
        group: "allergen",
        label: "May contain eggs",
        source: "llm",
        tone: "warning",
        note: null,
        method: "llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1",
      },
    ]);
  });

  it("maps the allergen noun for a sentence, including the deliberately BROADER shellfish mapping", () => {
    // `crustacean_shellfish` → "shellfish" is not a literal reading of the slug — it is
    // wider than it. That is intentional (recipe-tags.ts's ALLERGEN_NOUNS comment): a
    // warning is allowed to read broader than the finding, never narrower, because the
    // safe direction to be wrong in a warning is "cast a wider net", not a tighter one.
    const labels: RecipeTagLabel[] = [
      label({ dimension: "allergen", slug: "tree_nuts", verdict: "contains" }),
      label({ dimension: "allergen", slug: "crustacean_shellfish", verdict: "contains" }),
    ];
    const out = mergeRecipeTags({ author: author(), labels });
    expect(out.map((tag) => tag.label)).toEqual(["Contains shellfish", "Contains tree nuts"]);
  });
});

describe("mergeRecipeTags — author-wins dedupe", () => {
  it("collapses an author cuisine and a matching derived cuisine into one author-sourced tag, no method", () => {
    const out = mergeRecipeTags({ author: author({ cuisine: "Italian" }), labels: [label({ dimension: "cuisine", slug: "italian", verdict: "likely", method: "rules@2" })] });
    expect(out).toEqual([{ key: "author:Italian", group: "facet", label: "Italian", source: "author", tone: "neutral", note: null, method: null }]);
  });

  it("collapses an author diet and a matching derived diet into one author-sourced tag, no method", () => {
    const out = mergeRecipeTags({ author: author({ diets: ["Vegetarian"] }), labels: [label({ dimension: "diet", slug: "vegetarian", verdict: "likely", method: "rules@2" })] });
    expect(out).toEqual([{ key: "author:Vegetarian", group: "facet", label: "Vegetarian", source: "author", tone: "neutral", note: null, method: null }]);
  });

  // ── THE DEDUPE EXCEPTION ───────────────────────────────────────────────────
  //
  // Allergen warnings are exempt from author-wins: the merge's `tag.tone !== "warning"`
  // guard means a colliding allergen tag is never dropped. The reasoning (mergeRecipeTags's
  // own comment) is that an author declaring a fact ("Dairy-free") does not un-say a
  // classifier finding ("Contains milk") — silencing the warning would be resolving a
  // disagreement in the wrong direction, and disagreements are supposed to stand side by
  // side, not have one side quietly win.
  //
  // In practice an allergen tag's rendered text ("Contains milk") and an author facet's
  // free text ("Dairy-free") essentially never normalize to the same string, so this
  // collision is rare to hit organically — which is exactly why it needs a test that
  // FORCES the collision rather than one that merely asserts two unrelated tags coexist
  // (that would pass trivially even if the exception branch were deleted). So the author
  // facet below is deliberately given the same text an allergen tag would render, to
  // actually exercise the `tone !== "warning"` guard.
  it("does not drop an allergen warning even when its text collides with an author facet", () => {
    const out = mergeRecipeTags({
      author: author({ cookingMethod: "Contains milk" }),
      labels: [label({ dimension: "allergen", slug: "milk", verdict: "contains" })],
    });
    expect(out).toEqual([
      { key: "allergen:milk", group: "allergen", label: "Contains milk", source: "rules", tone: "warning", note: null, method: "rules@2" },
      { key: "author:Contains milk", group: "facet", label: "Contains milk", source: "author", tone: "neutral", note: null, method: null },
    ]);
  });

  it("still lets a non-warning derived tag (e.g. diet) be dropped by a colliding author facet phrased like 'Dairy-free'", () => {
    // The plan's own example: author "Dairy-free" alongside a derived diet slug that
    // humanizes to the same text collapses to one author tag, same as any other
    // non-warning dedupe — this is the ordinary rule, not the exception above.
    const out = mergeRecipeTags({
      author: author({ diets: ["Dairy-free"] }),
      labels: [label({ dimension: "diet", slug: "dairy_free", verdict: "likely", method: "rules@2" })],
    });
    expect(out).toEqual([{ key: "author:Dairy-free", group: "facet", label: "Dairy-free", source: "author", tone: "neutral", note: null, method: null }]);
  });
});

describe("mergeRecipeTags — slug humanization", () => {
  it("humanizes pipeline-only cuisine/diet slugs via the local override map", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "cuisine", slug: "tex_mex", verdict: "likely" }),
      label({ dimension: "cuisine", slug: "cajun_creole", verdict: "likely" }),
      label({ dimension: "cuisine", slug: "southern_us", verdict: "likely" }),
      label({ dimension: "diet", slug: "dairy_free", verdict: "likely" }),
    ];
    const out = mergeRecipeTags({ author: author(), labels });
    // diets sort before cuisine in the merge's overall order (see the ordering test below),
    // so "Dairy-free" leads even though it's listed last in the input array.
    expect(out.map((tag) => tag.label)).toEqual(["Dairy-free", "Tex-Mex", "Cajun & Creole", "Southern US"]);
  });

  it("falls back to startCase for an unknown future slug instead of crashing or vanishing", () => {
    const out = mergeRecipeTags({ author: author(), labels: [label({ dimension: "cuisine", slug: "cascadian_fusion", verdict: "likely" })] });
    expect(out).toEqual([{ key: "cuisine:cascadian_fusion", group: "cuisine", label: "Cascadian Fusion", source: "rules", tone: "neutral", note: null, method: "rules@2" }]);
  });
});

describe("mergeRecipeTags — ordering", () => {
  it("orders contains before may_contain, alpha within each verdict, then diets, cuisine, meal, spice, then author facets last", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "spice_level", slug: "hot", verdict: "likely" }),
      label({ dimension: "meal_type", slug: "breakfast", verdict: "likely" }),
      label({ dimension: "cuisine", slug: "italian", verdict: "likely" }),
      label({ dimension: "diet", slug: "vegan", verdict: "likely" }),
      label({ dimension: "allergen", slug: "soy", verdict: "may_contain" }),
      label({ dimension: "allergen", slug: "peanut", verdict: "contains" }),
      label({ dimension: "allergen", slug: "egg", verdict: "contains" }),
    ];
    const out = mergeRecipeTags({ author: author({ category: "Dinner" }), labels });
    expect(out.map((tag) => tag.key)).toEqual([
      "allergen:egg",
      "allergen:peanut",
      "allergen:soy",
      "diet:vegan",
      "cuisine:italian",
      "meal_type:breakfast",
      "spice_level:hot",
      "author:Dinner",
    ]);
  });
});

describe("mergeRecipeTags — spice copy", () => {
  it("renders mild/medium/hot with their fixed copy", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "spice_level", slug: "mild", verdict: "likely" }),
      label({ dimension: "spice_level", slug: "medium", verdict: "likely" }),
      label({ dimension: "spice_level", slug: "hot", verdict: "likely" }),
    ];
    // one at a time — they'd collapse to one key each anyway, but reading three
    // separate merges keeps the assertion below a simple label-per-slug table
    const mild = mergeRecipeTags({ author: author(), labels: [labels[0]] });
    const medium = mergeRecipeTags({ author: author(), labels: [labels[1]] });
    const hot = mergeRecipeTags({ author: author(), labels: [labels[2]] });
    expect(mild.map((tag) => tag.label)).toEqual(["Mild spice"]);
    expect(medium.map((tag) => tag.label)).toEqual(["Medium spice"]);
    expect(hot.map((tag) => tag.label)).toEqual(["Hot & spicy"]);
  });
});

describe("mergeRecipeTags — note and method passthrough", () => {
  it("passes note through unchanged on a derived tag, and sets method on derived / null on author tags", () => {
    const out = mergeRecipeTags({
      author: author({ cuisine: "French" }),
      labels: [
        label({
          dimension: "allergen",
          slug: "milk",
          verdict: "contains",
          note: "Butter and parmesan both carry milk.",
          method: "llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1",
          source: "llm",
        }),
      ],
    });
    const allergenTag = out.find((tag) => tag.group === "allergen");
    const authorTag = out.find((tag) => tag.group === "facet");
    expect(allergenTag?.note).toBe("Butter and parmesan both carry milk.");
    expect(allergenTag?.method).toBe("llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1");
    expect(authorTag?.note).toBeNull();
    expect(authorTag?.method).toBeNull();
  });
});

// `RecipeTag` has no `confidence` field in its type, which is the point (recipe-tags.ts's
// module doc, "CONFIDENCE IS NOT HERE, AND CANNOT BE") — but a type-level absence does not
// stop a stray `...label` spread from leaking the field back in at runtime. This asserts the
// runtime object actually has no such key, which is the only way the claim is checked outside
// the type system.
describe("mergeRecipeTags — confidence is structurally absent at runtime, not just in the type", () => {
  it("never returns a tag object with a 'confidence' key", () => {
    const labels: RecipeTagLabel[] = [
      label({ dimension: "allergen", slug: "milk", verdict: "contains" }),
      label({ dimension: "diet", slug: "vegan", verdict: "likely" }),
      label({ dimension: "cuisine", slug: "italian", verdict: "likely" }),
    ];
    const out = mergeRecipeTags({ author: author({ cuisine: "Thai", diets: ["Vegan"] }), labels });
    expect(out.length).toBeGreaterThan(0);
    for (const tag of out) {
      expect(Object.prototype.hasOwnProperty.call(tag, "confidence")).toBe(false);
    }
  });
});
