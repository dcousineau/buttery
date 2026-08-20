import { describe, expect, it } from "vitest";
import { contentFingerprint, normalizeSourceUrl } from "@buttery/recipe-schemas/normalize";
import { dedupeKeys } from "#/workflows/atproto-sync/render.ts";

/**
 * Dedupe keys written by the cron-sync render path (paprika-import plan §6.6,
 * "writer 3").
 *
 * ── THE GOLDEN VECTOR IS THE CROSS-PATH ASSERTION (§6.6, §14) ─────────────
 * The plan requires that this path and the web write path produce BYTE-
 * IDENTICAL keys for the same recipe. The two live in different packages and
 * neither may import the other, so the contract is pinned as literal expected
 * values below, duplicated verbatim in the web-side test
 * (`services/web/src/db/backfill-recipe-dedupe-keys.test.ts`, which covers the
 * third writer, the backfill). Any path that drifts fails its own test against
 * a constant, which is exactly the failure you want — a test that only compares
 * two paths to each other passes happily when both drift together.
 *
 * The literals were produced by `@buttery/recipe-schemas/normalize` and are NOT
 * to be "fixed" by re-running the code and pasting the new output: a change
 * here means every stored dedupe key in production is now unmatched, and needs
 * a re-backfill, not a test edit.
 */

// Deliberately exercises the parts of normalization most likely to drift:
// combining diacritics, an NFKC vulgar fraction, edge punctuation, mixed case,
// unsorted ingredients, and NYT's host-scoped tracking junk plus a real param.
const GOLDEN = {
  name: "Crème Brûlée",
  ingredients: ["  2 CUPS   heavy cream ", "½ cup Sugar", "(4 egg yolks),"],
  sourceUrl: "https://cooking.nytimes.com/recipes/1017-classic-creme-brulee?action=click&module=Rank&pgType=recipe&utm_source=nl&servings=6#top",
  contentFp: "sha256:89480081b831f33effb3ccc89f80e24c0823faedf4263a647c3cfd52501a0dec",
  sourceUrlKey: "cooking.nytimes.com/recipes/1017-classic-creme-brulee?servings=6",
} as const;

/** A minimal projected recipe — `dedupeKeys` reads only these three fields. */
function projected(over: { name?: string; ingredients?: string[]; kind?: string; url?: string | null } = {}) {
  return {
    name: over.name ?? GOLDEN.name,
    ingredients: over.ingredients ?? [...GOLDEN.ingredients],
    attribution: {
      kind: over.kind ?? "website",
      displayName: null,
      author: null,
      publisher: null,
      url: over.url === undefined ? GOLDEN.sourceUrl : over.url,
      license: null,
      raw: {},
    },
  };
}

describe("dedupeKeys", () => {
  it("produces the golden keys the web write path and the backfill must also produce", async () => {
    expect(await dedupeKeys(projected())).toEqual([
      ["source_url_key", GOLDEN.sourceUrlKey],
      ["content_fp", GOLDEN.contentFp],
    ]);
  });

  it("is byte-identical to calling the shared normalize helpers directly", async () => {
    const keys = new Map(await dedupeKeys(projected()));
    expect(keys.get("content_fp")).toBe(await contentFingerprint(GOLDEN.name, GOLDEN.ingredients));
    expect(keys.get("source_url_key")).toBe(normalizeSourceUrl(GOLDEN.sourceUrl));
  });

  it("emits no source_url_key row when there is no attribution at all", async () => {
    expect(await dedupeKeys({ name: GOLDEN.name, ingredients: [...GOLDEN.ingredients], attribution: null })).toEqual([["content_fp", GOLDEN.contentFp]]);
  });

  it("emits no source_url_key row for a non-website attribution, matching the backfill's kind filter", async () => {
    // A person/show attribution's URL identifies the author, not the recipe's
    // source page; the backfill migration filters on `kind = 'website'` and this
    // path must agree or the two writers disagree about the same recipe.
    expect(await dedupeKeys(projected({ kind: "person" }))).toEqual([["content_fp", GOLDEN.contentFp]]);
  });

  it("emits no source_url_key row for a URL that does not normalize", async () => {
    expect(await dedupeKeys(projected({ url: "mailto:cook@example.com" }))).toEqual([["content_fp", GOLDEN.contentFp]]);
    expect(await dedupeKeys(projected({ url: null }))).toEqual([["content_fp", GOLDEN.contentFp]]);
  });

  it("is stable under ingredient reordering but not under a content change", async () => {
    const reordered = await dedupeKeys(projected({ ingredients: [...GOLDEN.ingredients].reverse() }));
    expect(new Map(reordered).get("content_fp")).toBe(GOLDEN.contentFp);

    const changed = await dedupeKeys(projected({ ingredients: [...GOLDEN.ingredients, "1 tsp vanilla"] }));
    expect(new Map(changed).get("content_fp")).not.toBe(GOLDEN.contentFp);
  });

  it("always emits content_fp, even with no ingredients", async () => {
    const keys = await dedupeKeys({ name: "Toast", ingredients: [], attribution: null });
    expect(keys.map(([key]) => key)).toEqual(["content_fp"]);
  });
});
