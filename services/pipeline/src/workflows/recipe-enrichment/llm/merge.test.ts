import { describe, expect, it } from "vitest";
import { mergeLlmLabels } from "#/workflows/recipe-enrichment/llm/merge.ts";
import { llmMethod } from "#/workflows/recipe-enrichment/llm/schema.ts";
import type { LlmOutput } from "#/workflows/recipe-enrichment/llm/schema.ts";
import { RULES_METHOD } from "#/workflows/recipe-enrichment/classifiers/shared.ts";
import type { ClassifierLine, Evidence, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * Pure suite over hand-built `MergeInput`s (plan §8, §12.1) — no database, no
 * LLM call, no `classify.ts`. Every `it` below is one row of §8's table
 * (`merge.ts`'s doc comment carries the table itself; read it alongside this
 * file), plus the specific cases §12.1 calls out by name: the fish-sauce
 * downgrade attempt, both directions of resolving a rules `unknown`, the
 * cuisine cap, and confidence clamping.
 *
 * `writes` are the LLM's rows ONLY — a rules label must never appear in
 * `writes` (`merge.ts`'s "`writes` IS THE LLM'S ROWS ONLY" note). Several
 * tests assert that directly rather than trusting the shape.
 */

const PROVIDER = "moonshot";
const MODEL = "kimi-k2-0905-preview";
const METHOD = llmMethod(PROVIDER, MODEL);

function line(ordinal: number, text: string): ClassifierLine {
  return { ordinal, text, name: text, quantity: null, unit: null, foodSlug: null, via: "miss", traits: null };
}

const LINES: ClassifierLine[] = [line(1, "2 tbsp fish sauce"), line(2, "1 cup coconut milk"), line(3, "1 tbsp lime juice")];

/** One rules-authored `Label`, built the same way `classifiers/shared.ts`'s `makeLabel` would. */
function rulesLabel(dimension: Label["dimension"], slug: string, verdict: Label["verdict"], confidence = 0.8, lines: ClassifierLine[] = []): Label {
  const evidence: Evidence = { rule: "rules-fixture", lines: lines.map((l) => ({ ordinal: l.ordinal, text: l.text, foodSlug: l.foodSlug })) };
  return { dimension, slug, verdict, confidence, method: RULES_METHOD, evidence };
}

/** A full, valid-shaped `LlmOutput`, sparse by default and overridable per field — mirrors what `llmOutputSchema.parse` would hand `classify.ts`. */
function llmOutput(partial: Partial<LlmOutput>): LlmOutput {
  return {
    allergens: [],
    diets: [],
    cuisine: [],
    mealType: [],
    spiceLevel: null,
    ...partial,
  };
}

function findWrite(writes: Label[], dimension: Label["dimension"], slug: string): Label {
  const found = writes.find((w) => w.dimension === dimension && w.slug === slug);
  if (!found) throw new Error(`no write for ${dimension}/${slug}`);
  return found;
}

describe("merge — empty LLM output", () => {
  it("produces zero writes and zero disagreements against any rules labels", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "fish", "contains"), rulesLabel("diet", "vegetarian", "likely")],
      llm: llmOutput({}),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });
});

describe("allergen — §8 table row 1: no rules row, LLM escalates", () => {
  it.each(["contains", "may_contain"] as const)("writes an LLM row when the rules row is absent and the model says %s", (verdict) => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "peanut", verdict, confidence: 0.7, ordinals: [1], note: "peanut butter mentioned" }] }),
      lines: [line(1, "1/4 cup peanut butter")],
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toHaveLength(1);
    const write = findWrite(result.writes, "allergen", "peanut");
    expect(write.verdict).toBe(verdict);
    expect(write.method).toBe(METHOD);
    expect(write.evidence.rule).toBe("llm");
    expect(write.evidence.lines).toEqual([{ ordinal: 1, text: "1/4 cup peanut butter", foodSlug: null }]);
    expect(result.disagreements).toEqual([]);
  });
});

describe("allergen — §8 table row 2: no rules row, LLM says not_detected or omits", () => {
  it("writes nothing when the model explicitly says not_detected", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "peanut", verdict: "not_detected", confidence: 0.6, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });

  it("writes nothing when the model omits the slug entirely", () => {
    const result = mergeLlmLabels({ rulesLabels: [], llm: llmOutput({}), lines: LINES, provider: PROVIDER, model: MODEL });
    expect(result.writes).toEqual([]);
  });
});

describe("allergen — §8 table rows 3–4: rules `unknown` resolves in either direction", () => {
  it("escalates: rules unknown, LLM says contains -> write replaces the unknown row, noting the replacement", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "milk", "unknown", 0.4)],
      llm: llmOutput({ allergens: [{ slug: "milk", verdict: "contains", confidence: 0.85, ordinals: [], note: "labeled as containing dairy" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "milk");
    expect(write.verdict).toBe("contains");
    expect(write.method).toBe(METHOD);
    expect(write.evidence.note).toContain("labeled as containing dairy");
    expect(write.evidence.note).toContain('replaces rules verdict "unknown"');
    expect(result.disagreements).toEqual([]);
  });

  it("also escalates on may_contain: rules unknown, LLM says may_contain -> write replaces the unknown row", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "sesame", "unknown", 0.4)],
      llm: llmOutput({ allergens: [{ slug: "sesame", verdict: "may_contain", confidence: 0.5, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "sesame");
    expect(write.verdict).toBe("may_contain");
    expect(write.evidence.note).toBe('replaces rules verdict "unknown"');
  });

  it("resolves the other direction: rules unknown, LLM says not_detected -> a stored not_detected row, method llm, noting the replacement", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "tree_nuts", "unknown", 0.4)],
      llm: llmOutput({ allergens: [{ slug: "tree_nuts", verdict: "not_detected", confidence: 0.75, ordinals: [], note: "no nut ingredients found" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "tree_nuts");
    expect(write.verdict).toBe("not_detected");
    expect(write.method).toBe(METHOD);
    expect(write.evidence.note).toContain("no nut ingredients found");
    expect(write.evidence.note).toContain('replaces rules verdict "unknown"');
    expect(result.disagreements).toEqual([]);
  });
});

describe("allergen — §8 table row 5: the fish-sauce downgrade attempt", () => {
  it("rules says fish contains; LLM says not_detected -> rules row stands, exactly one disagreement, zero writes for fish", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "fish", "contains", 0.95, [line(1, "2 tbsp fish sauce")])],
      llm: llmOutput({ allergens: [{ slug: "fish", verdict: "not_detected", confidence: 0.6, ordinals: [1], note: "fish sauce is a condiment, not fish" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes.filter((w) => w.dimension === "allergen" && w.slug === "fish")).toEqual([]);
    expect(result.disagreements).toEqual([{ dimension: "allergen", slug: "fish", rulesVerdict: "contains", llmVerdict: "not_detected", llmConfidence: 0.6 }]);
  });

  it("rules says contains, LLM says may_contain (still weaker) -> rules stands, disagreement emitted", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "milk", "contains")],
      llm: llmOutput({ allergens: [{ slug: "milk", verdict: "may_contain", confidence: 0.5, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([{ dimension: "allergen", slug: "milk", rulesVerdict: "contains", llmVerdict: "may_contain", llmConfidence: 0.5 }]);
  });

  it("rules says may_contain, LLM says not_detected (weaker) -> rules stands, disagreement emitted", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "wheat", "may_contain")],
      llm: llmOutput({ allergens: [{ slug: "wheat", verdict: "not_detected", confidence: 0.4, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([{ dimension: "allergen", slug: "wheat", rulesVerdict: "may_contain", llmVerdict: "not_detected", llmConfidence: 0.4 }]);
  });

  it("agreement is neither a write nor a disagreement: rules contains, LLM also contains", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "egg", "contains")],
      llm: llmOutput({ allergens: [{ slug: "egg", verdict: "contains", confidence: 0.9, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });
});

describe("allergen — §8 table row 6: may_contain -> contains is an escalation", () => {
  it("writes the LLM row when rules says may_contain and the model says contains", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "soy", "may_contain", 0.5)],
      llm: llmOutput({ allergens: [{ slug: "soy", verdict: "contains", confidence: 0.9, ordinals: [1], note: "soy sauce confirmed in the label" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "soy");
    expect(write.verdict).toBe("contains");
    expect(write.method).toBe(METHOD);
    // Escalating a real (non-`unknown`) rules verdict is not a "replacement" —
    // no rules-verdict note is composed in, only the model's own note.
    expect(write.evidence.note).toBe("soy sauce confirmed in the label");
    expect(result.disagreements).toEqual([]);
  });
});

describe("diet — §8 table row 7: rules excluded stands no matter what the LLM says", () => {
  it("emits a disagreement when the LLM says likely against a rules excluded", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("diet", "vegan", "excluded")],
      llm: llmOutput({ diets: [{ slug: "vegan", verdict: "likely", confidence: 0.55, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([{ dimension: "diet", slug: "vegan", rulesVerdict: "excluded", llmVerdict: "likely", llmConfidence: 0.55 }]);
  });

  it("emits no disagreement when the LLM agrees the diet is excluded", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("diet", "vegan", "excluded")],
      llm: llmOutput({ diets: [{ slug: "vegan", verdict: "excluded", confidence: 0.9, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });
});

describe("diet — §8 table row 8: excluded is always the safe write", () => {
  it.each(["likely", "unknown"] as const)("writes an excluded row over a rules %s row", (rulesVerdict) => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("diet", "gluten_free", rulesVerdict)],
      llm: llmOutput({ diets: [{ slug: "gluten_free", verdict: "excluded", confidence: 0.8, ordinals: [2], note: "barley malt found" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "diet", "gluten_free");
    expect(write.verdict).toBe("excluded");
    expect(write.method).toBe(METHOD);
    expect(write.evidence.note).toContain("barley malt found");
    expect(write.evidence.note).toContain(`replaces rules verdict "${rulesVerdict}"`);
    expect(result.disagreements).toEqual([]);
  });
});

describe("diet — §8 table row 9: likely is written only where rules had unknown or nothing", () => {
  it("writes when the rules row was unknown, noting the replacement", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("diet", "dairy_free", "unknown")],
      llm: llmOutput({ diets: [{ slug: "dairy_free", verdict: "likely", confidence: 0.6, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "diet", "dairy_free");
    expect(write.verdict).toBe("likely");
    expect(write.evidence.note).toBe('replaces rules verdict "unknown"');
  });

  it("writes when there was no rules row at all", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ diets: [{ slug: "pescatarian", verdict: "likely", confidence: 0.6, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "diet", "pescatarian");
    expect(write.verdict).toBe("likely");
    // Nothing to replace, so no replacement note is composed in.
    expect(write.evidence.note).toBeUndefined();
  });

  it("writes nothing when the rules row already said likely — same claim, no benefit to a duplicate row", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("diet", "vegetarian", "likely")],
      llm: llmOutput({ diets: [{ slug: "vegetarian", verdict: "likely", confidence: 0.7, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });
});

describe("diet — §8 table row 10: macro/paleo diets are always written (rules never has a row for them)", () => {
  it.each(["keto", "low_carb", "low_fat", "low_calorie", "diabetic", "paleo"] as const)("writes a %s row from the LLM alone, likely or excluded", (slug) => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ diets: [{ slug, verdict: "likely", confidence: 0.55, ordinals: [], note: "mostly meat and fat, no grains" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "diet", slug);
    expect(write.verdict).toBe("likely");
    expect(write.method).toBe(METHOD);
  });

  it("also writes a macro-diet exclusion straight through, no rules row to consult", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ diets: [{ slug: "keto", verdict: "excluded", confidence: 0.7, ordinals: [], note: "a full cup of rice" }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "diet", "keto").verdict).toBe("excluded");
  });
});

describe("cuisine / meal_type — LLM-owned, capped at 2", () => {
  it("writes both cuisine entries under the cap", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({
        cuisine: [
          { slug: "mexican", confidence: 0.6 },
          { slug: "tex_mex", confidence: 0.5 },
        ],
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const cuisineWrites = result.writes.filter((w) => w.dimension === "cuisine");
    expect(cuisineWrites).toHaveLength(2);
    for (const w of cuisineWrites) {
      expect(w.verdict).toBe("likely");
      expect(w.method).toBe(METHOD);
    }
  });

  it("caps at 2 and keeps the two highest-confidence entries when more arrive from a hand-built LlmOutput", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({
        cuisine: [
          { slug: "italian", confidence: 0.3 },
          { slug: "greek", confidence: 0.9 },
          { slug: "spanish", confidence: 0.6 },
        ],
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const cuisineSlugs = result.writes.filter((w) => w.dimension === "cuisine").map((w) => w.slug);
    expect(cuisineSlugs).toHaveLength(2);
    expect(cuisineSlugs.sort()).toEqual(["greek", "spanish"]);
  });

  it("caps meal_type at 2 the same way, keeping the two highest-confidence entries", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({
        mealType: [
          { slug: "breakfast", confidence: 0.4 },
          { slug: "snack", confidence: 0.2 },
          { slug: "brunch" as never, confidence: 0.9 },
        ] as LlmOutput["mealType"],
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const mealTypeSlugs = result.writes.filter((w) => w.dimension === "meal_type").map((w) => w.slug);
    expect(mealTypeSlugs).toHaveLength(2);
    expect(mealTypeSlugs.sort()).toEqual(["brunch", "breakfast"].sort());
  });
});

describe("spice_level — LLM-owned, at most one row", () => {
  it("writes one row when the model gives a spice level", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ spiceLevel: { slug: "hot", confidence: 0.65 } }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "spice_level", "hot");
    expect(write.verdict).toBe("likely");
    expect(write.method).toBe(METHOD);
  });

  it("writes nothing when spiceLevel is null", () => {
    const result = mergeLlmLabels({ rulesLabels: [], llm: llmOutput({ spiceLevel: null }), lines: LINES, provider: PROVIDER, model: MODEL });
    expect(result.writes.filter((w) => w.dimension === "spice_level")).toEqual([]);
  });
});

describe("confidence clamping", () => {
  it("clamps a confidence above 1 down to 1", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "peanut", verdict: "contains", confidence: 1.4, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "allergen", "peanut").confidence).toBe(1);
  });

  it("clamps a confidence below 0 up to 0", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ diets: [{ slug: "vegan", verdict: "likely", confidence: -0.2, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "diet", "vegan").confidence).toBe(0);
  });

  it("does NOT re-clamp a macro-diet confidence to the prompt's 0.6 ceiling — that ceiling is the prompt's job, graded by the judge evals, not merge.ts's", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ diets: [{ slug: "keto", verdict: "likely", confidence: 0.95, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "diet", "keto").confidence).toBe(0.95);
  });

  it("leaves an in-range confidence untouched", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "milk", verdict: "may_contain", confidence: 0.42, ordinals: [], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "allergen", "milk").confidence).toBe(0.42);
  });
});

describe("evidence — ordinal resolution", () => {
  it("resolves cited ordinals to real EvidenceLines", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "fish", verdict: "may_contain", confidence: 0.6, ordinals: [1], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(findWrite(result.writes, "allergen", "fish").evidence.lines).toEqual([{ ordinal: 1, text: "2 tbsp fish sauce", foodSlug: null }]);
  });

  it("silently drops a hallucinated ordinal the recipe does not have, without dropping the verdict", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "fish", verdict: "may_contain", confidence: 0.6, ordinals: [1, 99], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "fish");
    expect(write.verdict).toBe("may_contain");
    expect(write.evidence.lines).toEqual([{ ordinal: 1, text: "2 tbsp fish sauce", foodSlug: null }]);
  });

  it("drops every ordinal when all are hallucinated, still keeping the verdict", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ allergens: [{ slug: "milk", verdict: "contains", confidence: 0.6, ordinals: [42], note: undefined }] }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const write = findWrite(result.writes, "allergen", "milk");
    expect(write.evidence.lines).toEqual([]);
    expect(write.verdict).toBe("contains");
  });
});

describe("method stamping", () => {
  it("stamps every emitted write with llmMethod(provider, model) and never with RULES_METHOD", () => {
    const result = mergeLlmLabels({
      rulesLabels: [rulesLabel("allergen", "milk", "unknown"), rulesLabel("diet", "vegan", "excluded")],
      llm: llmOutput({
        allergens: [{ slug: "milk", verdict: "contains", confidence: 0.7, ordinals: [], note: undefined }],
        diets: [
          { slug: "vegan", verdict: "likely", confidence: 0.5, ordinals: [], note: undefined },
          { slug: "keto", verdict: "likely", confidence: 0.4, ordinals: [], note: undefined },
        ],
        cuisine: [{ slug: "thai", confidence: 0.5 }],
        mealType: [{ slug: "dinner", confidence: 0.5 }],
        spiceLevel: { slug: "medium", confidence: 0.5 },
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result.writes.length).toBeGreaterThan(0);
    for (const write of result.writes) {
      expect(write.method).toBe(METHOD);
      expect(write.method).not.toBe(RULES_METHOD);
    }
  });

  it("carries provider and model into the method string", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({ spiceLevel: { slug: "mild", confidence: 0.5 } }),
      lines: LINES,
      provider: "qwen",
      model: "qwen-max",
    });
    expect(findWrite(result.writes, "spice_level", "mild").method).toBe(llmMethod("qwen", "qwen-max"));
    expect(findWrite(result.writes, "spice_level", "mild").method).not.toBe(METHOD);
  });
});

describe("determinism and ordering", () => {
  it("returns the same result for the same input", () => {
    const input = {
      rulesLabels: [rulesLabel("allergen", "fish", "contains")],
      llm: llmOutput({
        allergens: [{ slug: "fish", verdict: "not_detected" as const, confidence: 0.5, ordinals: [], note: undefined }],
        diets: [{ slug: "keto", verdict: "likely" as const, confidence: 0.4, ordinals: [], note: undefined }],
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    };
    expect(mergeLlmLabels(input)).toEqual(mergeLlmLabels(input));
  });

  it("sorts writes by dimension then slug regardless of input order", () => {
    const result = mergeLlmLabels({
      rulesLabels: [],
      llm: llmOutput({
        diets: [{ slug: "paleo", verdict: "likely", confidence: 0.4, ordinals: [], note: undefined }],
        allergens: [{ slug: "wheat", verdict: "contains", confidence: 0.8, ordinals: [], note: undefined }],
        cuisine: [{ slug: "italian", confidence: 0.5 }],
      }),
      lines: LINES,
      provider: PROVIDER,
      model: MODEL,
    });
    const shape = result.writes.map((w) => `${w.dimension}/${w.slug}`);
    expect(shape).toEqual([...shape].sort());
  });
});
