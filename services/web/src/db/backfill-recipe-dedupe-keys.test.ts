import { describe, expect, it } from "vitest";
import { contentFingerprint, normalizeSourceUrl } from "@buttery/recipe-schemas/normalize";
import { dedupeMetaRowsFor } from "./migrations/1786332588495_backfill_recipe_dedupe_keys";

/**
 * The backfill migration's per-recipe computation (paprika-import plan §6.5,
 * acceptance §16.15: "byte-identical to the runtime computation").
 *
 * The migration factors its whole per-recipe logic into `dedupeMetaRowsFor` so
 * this can be a plain unit test — no migration runner, no database, and no
 * second copy of the logic that could pass this test while the migration does
 * something else.
 *
 * ── THE GOLDEN VECTOR IS THE CROSS-PATH ASSERTION (§6.6, §14) ─────────────
 * The same literals are asserted, verbatim and independently, in
 * the `atproto-sync` workflow's `render.test.ts` and `render.db.test.ts` —
 * the sweep's render path, which is the third writer of these keys. Comparing the
 * two paths only to each other would pass happily if both drifted together, so
 * each pins itself to a constant instead.
 *
 * These literals are NOT to be "fixed" by pasting fresh output: a change means
 * every dedupe key already stored is now unmatched and the fix is a re-backfill,
 * not a test edit.
 */
const GOLDEN = {
  name: "Crème Brûlée",
  ingredients: ["  2 CUPS   heavy cream ", "½ cup Sugar", "(4 egg yolks),"],
  sourceUrl: "https://cooking.nytimes.com/recipes/1017-classic-creme-brulee?action=click&module=Rank&pgType=recipe&utm_source=nl&servings=6#top",
  contentFp: "sha256:89480081b831f33effb3ccc89f80e24c0823faedf4263a647c3cfd52501a0dec",
  sourceUrlKey: "cooking.nytimes.com/recipes/1017-classic-creme-brulee?servings=6",
} as const;

const RECIPE_ID = "01JEVQRA9MCR23263PARX101PE";

function input(over: { name?: string; ingredients?: string[]; sourceUrl?: string | null } = {}) {
  return {
    recipeId: RECIPE_ID,
    name: over.name ?? GOLDEN.name,
    ingredients: over.ingredients ?? [...GOLDEN.ingredients],
    sourceUrl: over.sourceUrl === undefined ? GOLDEN.sourceUrl : over.sourceUrl,
  };
}

describe("dedupeMetaRowsFor (backfill migration)", () => {
  it("produces the golden keys the cron render path must also produce", async () => {
    expect(await dedupeMetaRowsFor(input())).toEqual([
      { recipeId: RECIPE_ID, key: "source_url_key", value: GOLDEN.sourceUrlKey },
      { recipeId: RECIPE_ID, key: "content_fp", value: GOLDEN.contentFp },
    ]);
  });

  it("is byte-identical to the runtime functions (§16.15)", async () => {
    const rows = new Map((await dedupeMetaRowsFor(input())).map((r) => [r.key, r.value]));
    expect(rows.get("content_fp")).toBe(await contentFingerprint(GOLDEN.name, GOLDEN.ingredients));
    expect(rows.get("source_url_key")).toBe(normalizeSourceUrl(GOLDEN.sourceUrl));
  });

  it("writes no source_url_key row when there is no usable URL", async () => {
    // Absence is the signal, not a null value (§6.1).
    for (const sourceUrl of [null, "", "   ", "mailto:cook@example.com", "not a url", "ftp://example.com/x"]) {
      const rows = await dedupeMetaRowsFor(input({ sourceUrl }));
      expect(rows.map((r) => r.key)).toEqual(["content_fp"]);
    }
  });

  it("always writes content_fp, including for a recipe with no ingredients", async () => {
    const rows = await dedupeMetaRowsFor({ recipeId: RECIPE_ID, name: "Toast", sourceUrl: null, ingredients: [] });
    expect(rows).toEqual([{ recipeId: RECIPE_ID, key: "content_fp", value: await contentFingerprint("Toast", []) }]);
  });

  it("does not depend on the order ingredients are read out of recipe_ingredient", async () => {
    // The migration reads `recipe_ingredient` by its `ordinal` column so the
    // lines arrive in stored order; `contentFingerprintInput` sorts internally,
    // so the fingerprint must not change even if that ordering ever did.
    const forward = await dedupeMetaRowsFor(input());
    const reversed = await dedupeMetaRowsFor(input({ ingredients: [...GOLDEN.ingredients].reverse() }));
    expect(reversed).toEqual(forward);
  });

  it("changes the fingerprint when the name or the ingredients change", async () => {
    const renamed = await dedupeMetaRowsFor(input({ name: "Creme Caramel" }));
    expect(new Map(renamed.map((r) => [r.key, r.value])).get("content_fp")).not.toBe(GOLDEN.contentFp);

    const extra = await dedupeMetaRowsFor(input({ ingredients: [...GOLDEN.ingredients, "1 tsp vanilla"] }));
    expect(new Map(extra.map((r) => [r.key, r.value])).get("content_fp")).not.toBe(GOLDEN.contentFp);
  });
});
