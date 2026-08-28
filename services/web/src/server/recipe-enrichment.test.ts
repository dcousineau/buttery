import { describe, expect, it } from "vitest";
import { enrichmentTagLabels, type RecipeEnrichmentLabelView, type RecipeEnrichmentView } from "./recipe-enrichment.ts";
import type { JsonValue } from "#/db/types";

/**
 * `enrichmentTagLabels` is pure and its imports (`Kysely`, `DB`, `RecipeTagLabel`) are
 * types-only — nothing here needs a database, which is exactly what lets this be a plain
 * `unit` suite (`*.test.ts`, not `*.db.test.ts`) rather than one gated behind `test:db`.
 *
 * Per the module doc's numbered list on `enrichmentTagLabels`, three things happen here and
 * nowhere else: source is derived from `method`, `evidence` collapses to `note`, and
 * `confidence` is dropped. The verdict policy (what a verdict is ALLOWED to render) is
 * explicitly NOT this module's job — that lives in `lib/recipe-tags.ts` and is pinned by
 * `recipe-tags.test.ts`. This file's job is narrower: does the flatten/derive step honestly
 * represent what is in `RecipeEnrichmentView`, without inventing a policy of its own.
 */

function labelRow(over: Partial<RecipeEnrichmentLabelView> = {}): RecipeEnrichmentLabelView {
  return { dimension: "allergen", slug: "milk", verdict: "contains", confidence: 0.95, method: "rules@2", evidence: null, updatedAt: "2026-08-01T00:00:00.000Z", ...over };
}

function view(labels: Record<string, RecipeEnrichmentLabelView[]>): RecipeEnrichmentView {
  return { recipeId: "recipe-1", status: "ready", classifierVersion: 2, inputHash: "hash-1", enrichedAt: "2026-08-01T00:00:00.000Z", error: null, labels };
}

describe("enrichmentTagLabels — null in, null out", () => {
  it("returns null for a recipe that has never been enriched, distinct from 'enriched to nothing'", () => {
    // `RecipeEnrichmentView | null` already tells these two states apart at the read
    // boundary (`getRecipeEnrichment`'s doc: "a real, distinct state"). This mapper's whole
    // job is to preserve that distinction rather than collapsing both into `[]`, which is
    // why the never-enriched case is `null`, not an empty array.
    expect(enrichmentTagLabels(null)).toBeNull();
  });

  it("returns [] (not null) for a view that exists but has no labels at all", () => {
    expect(enrichmentTagLabels(view({}))).toEqual([]);
  });
});

describe("enrichmentTagLabels — source derived from method", () => {
  it("reads a rules@N method as source 'rules'", () => {
    const out = enrichmentTagLabels(view({ allergen: [labelRow({ method: "rules@2" })] }));
    expect(out?.[0]?.source).toBe("rules");
  });

  it("reads an llm:provider:model@version method as source 'llm', via the llm: prefix alone", () => {
    const out = enrichmentTagLabels(view({ allergen: [labelRow({ method: "llm:moonshot:kimi-k2-0905-preview@v1" })] }));
    expect(out?.[0]?.source).toBe("llm");
  });
});

describe("enrichmentTagLabels — evidence.note extraction is defensive", () => {
  // `evidence` is untyped `JsonValue` at this boundary — nothing in the database enforces
  // its shape, and it is per-classifier (module doc, "Shape is per-classifier"). Every case
  // below is a shape `evidenceNote` must survive without throwing, because a malformed row
  // must degrade to "no note" for display, never crash the read path that serves the recipe
  // page. The happy path is included alongside them so this table also pins the one shape
  // that DOES produce a note, not just the ones that don't.
  const cases: Array<{ name: string; evidence: JsonValue | null; expectedNote: string | null }> = [
    { name: "null evidence", evidence: null, expectedNote: null },
    { name: "evidence that is a raw (unparsed) JSON string, not an object", evidence: '{"note":"looks right but is a string"}', expectedNote: null },
    { name: "evidence that is a bare number", evidence: 42, expectedNote: null },
    { name: "evidence that is an array", evidence: ["note", "milk"], expectedNote: null },
    { name: "an object with no 'note' key at all", evidence: { lines: ["butter", "parmesan"] }, expectedNote: null },
    { name: "an object whose 'note' is a number, not a string", evidence: { note: 5 }, expectedNote: null },
    { name: "an object whose 'note' is an empty string", evidence: { note: "" }, expectedNote: null },
    { name: "an object whose 'note' is all whitespace", evidence: { note: "   " }, expectedNote: null },
    { name: "the happy path: an object with a real string note", evidence: { note: "Butter and parmesan both carry milk." }, expectedNote: "Butter and parmesan both carry milk." },
  ];

  for (const { name, evidence, expectedNote } of cases) {
    it(`${name} → note: ${expectedNote === null ? "null" : JSON.stringify(expectedNote)}, no throw`, () => {
      // Called directly, not wrapped in `expect(() => …).not.toThrow()`: a thrown error here
      // fails this test on its own (vitest surfaces it as the test's failure), which is
      // exactly the "does not throw" guarantee this case exists to pin — no separate
      // assertion needed to say so.
      const out = enrichmentTagLabels(view({ allergen: [labelRow({ evidence })] }));
      expect(out?.[0]?.note).toBe(expectedNote);
    });
  }
});

describe("enrichmentTagLabels — confidence never appears on the output", () => {
  it("drops the 'confidence' key even though the input row carries one", () => {
    const out = enrichmentTagLabels(
      view({ allergen: [labelRow({ confidence: 0.95 })], diet: [labelRow({ dimension: "diet", slug: "vegan", verdict: "likely", confidence: 0.65 })] }),
    );
    expect(out).not.toBeNull();
    expect(out?.length).toBeGreaterThan(0);
    for (const label of out ?? []) {
      expect(Object.prototype.hasOwnProperty.call(label, "confidence")).toBe(false);
    }
  });
});

describe("enrichmentTagLabels — unknown dimensions are dropped, not passed through untyped", () => {
  it("drops a bucket like 'nutrition' that TAG_DIMENSIONS does not know about, keeping known dimensions", () => {
    const out = enrichmentTagLabels(
      view({
        allergen: [labelRow({ dimension: "allergen", slug: "milk", verdict: "contains" })],
        // Not one of "allergen" | "diet" | "cuisine" | "meal_type" | "spice_level" —
        // a hypothetical future dimension the pipeline could start writing before the
        // display code (RecipeTagLabel's dimension union) knows how to render it.
        nutrition: [labelRow({ dimension: "nutrition", slug: "high_protein", verdict: "likely" })],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.dimension).toBe("allergen");
    expect(out?.some((label) => (label.dimension as string) === "nutrition")).toBe(false);
  });
});

describe("enrichmentTagLabels — verdicts pass through unfiltered", () => {
  // The verdict policy (what a verdict is ALLOWED to become a visible tag) lives entirely in
  // `mergeRecipeTags` (lib/recipe-tags.ts), not here — the module doc says so explicitly
  // ("NOTE this does NOT apply the verdict policy"). So `not_detected` reaching this
  // function's output is CORRECT, not a bug: this mapper's contract is "flatten what is
  // stored", and filtering belongs to the one function with the safety-rule tests. If this
  // mapper started dropping verdicts too, there would be two places deciding what counts as
  // safe to show, and they could silently drift apart.
  it("lets 'not_detected' through — filtering it out is mergeRecipeTags's job, not this one's", () => {
    const out = enrichmentTagLabels(view({ allergen: [labelRow({ dimension: "allergen", slug: "peanut", verdict: "not_detected" })] }));
    expect(out).toEqual([{ dimension: "allergen", slug: "peanut", verdict: "not_detected", source: "rules", note: null, method: "rules@2" }]);
  });

  it("also lets 'unknown' and 'excluded' through untouched, for the same reason", () => {
    const out = enrichmentTagLabels(
      view({
        allergen: [labelRow({ dimension: "allergen", slug: "egg", verdict: "unknown" })],
        diet: [labelRow({ dimension: "diet", slug: "vegan", verdict: "excluded" })],
      }),
    );
    expect(out?.map((label) => label.verdict).sort()).toEqual(["excluded", "unknown"]);
  });
});
