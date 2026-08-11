import { describe, expect, it } from "vitest";
import { recipeRecordProblems, validateRecipeRecord, type RecipeRecordInput } from "./recipe-record.ts";

/**
 * `recipeRecordProblems` is a *prediction* of `persistRecipeDraft`'s verdict, shown to the
 * user before the import instead of after it. The tests that matter are the ones that keep
 * it honest in both directions: it must not miss a rejection (the user would be told
 * everything is fine and then lose the recipe), and it must not invent one (the user would
 * be sent to fix something the server was going to accept, or repair itself).
 */

function record(over: Partial<RecipeRecordInput> = {}): RecipeRecordInput {
  return { name: "Beef Bourguignon", text: "A stew.", ingredients: ["500g beef", "salt"], instructions: ["Brown the beef.", "Simmer."], ...over };
}

describe("recipeRecordProblems", () => {
  it("finds nothing wrong with a record the server would take", () => {
    expect(recipeRecordProblems(record())).toEqual([]);
    expect(validateRecipeRecord({ ...record(), $type: "exchange.recipe.recipe", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" }).status).toBe("ok");
  });

  it("names the field, the count and the cap, from the schema's own numbers", () => {
    const problems = recipeRecordProblems(record({ instructions: ["ok", "z".repeat(1120)] }));
    expect(problems).toEqual([
      { path: "instructions.1", field: "instructions", index: 1, label: "Step 2", message: "This step is 1,120 characters; the limit is 1,000.", editable: true },
    ]);
  });

  it("reports every problem at once, not the first one the schema trips on", () => {
    // The lexicon's object and array schemas both short-circuit, so a single whole-record
    // `$safeValidate` says "instructions.0" and stops. A user fixing one card at a time,
    // re-checking, and being handed a new surprise each round is the failure this walk exists
    // to prevent.
    const problems = recipeRecordProblems(record({ name: "n".repeat(300), ingredients: ["fine", "i".repeat(600)], instructions: ["s".repeat(1100), "s".repeat(1200)] }));
    expect(problems.map((problem) => problem.path)).toEqual(["name", "ingredients.1", "instructions.0", "instructions.1"]);
    expect(problems.map((problem) => problem.label)).toEqual(["Recipe name", "Ingredient 2", "Step 1", "Step 2"]);
    expect(problems[0].message).toBe("The recipe name is 300 characters; the limit is 255.");
  });

  it("says nothing about an over-long keyword, because the server drops it rather than refusing", () => {
    // `applyTags` in server/recipe-import.ts filters keywords longer than 64 characters
    // *before* validating. A card here would send the user to fix an import that was always
    // going to succeed — and to a field the import editor does not even show.
    expect(recipeRecordProblems(record({ keywords: ["fine", "k".repeat(200)] }))).toEqual([]);
  });

  it("says nothing about missing attribution, which is the sources group's question", () => {
    // The lexicon marks attribution optional; Buttery's stricter rule lives in
    // `resolveAttribution`, and the rail already asks it as its own step. Raising it here
    // would double-ask it, in a pane with no controls for answering it.
    expect(record().attribution).toBeUndefined();
    expect(recipeRecordProblems(record())).toEqual([]);
  });

  it("agrees with the write path's own gate", () => {
    const bad = record({ instructions: ["z".repeat(1120)] });
    expect(recipeRecordProblems(bad)).toHaveLength(1);
    const validated = validateRecipeRecord({ ...bad, $type: "exchange.recipe.recipe", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" });
    expect(validated.status).toBe("invalid");
    if (validated.status !== "invalid") throw new Error("unreachable");
    expect(validated.issues[0].path).toBe("instructions.0");
  });
});
