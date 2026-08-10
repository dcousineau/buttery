import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryEntrySource } from "../import/entry-source.ts";
import { isParseFailure, type ImportCandidate, type ImportEntry } from "../import/types.ts";
import { parsePaprikaRecipe } from "./recipe.ts";
import { walkPaprikaExport } from "./export.ts";

/**
 * Every fixture is a **real, unmodified file** from a 341-recipe Paprika 3 export (§4.3).
 * Synthesizing them defeats the purpose: the quirks these tests exist to pin down — an
 * instruction block that is one element, a rating hidden in an attribute, an image path that
 * is relative to the wrong thing — are exactly what a hand-written fixture would smooth over.
 *
 * | fixture                         | why it is here                                                     |
 * | ------------------------------- | ------------------------------------------------------------------ |
 * | beef-bourguignon                | URL source, image, notes, single category, yield prose, 6 steps     |
 * | air-fryer-chicken-parmesan      | `totalTime`, URL with tracking params (§6.1), multi-word category   |
 * | arroz-con-pollo                 | **no URL**, free-text source, no image, numeric yield, 3 tags       |
 * | apple-bourbon-bundt-cake        | the unparseable `1 1/2 hours plus cooling time` (§3.4)              |
 * | sourdough-discard-biscuits      | non-zero rating + difficulty, and an image with no remote original  |
 */
function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}.html`, import.meta.url), "utf8");
}

/** The shape the walker produces for a drop one level above the export root — the same
 *  two-path split §4.1 note 4 turns on. */
function entryFor(name: string): ImportEntry {
  return { entryName: `Recipes/${name}.html`, sourcePath: `Outer/My Recipes/Recipes/${name}.html`, html: fixture(name) };
}

function parsed(name: string): ImportCandidate {
  const entry = entryFor(name);
  const result = parsePaprikaRecipe(entry.html, entry);
  if (isParseFailure(result)) throw new Error(`expected a candidate for ${name}, got: ${result.message}`);
  return result;
}

describe("parsePaprikaRecipe — instructions (§4.1 note 1)", () => {
  it("splits the single recipeInstructions container into one step per <p>", () => {
    const { recipe } = parsed("beef-bourguignon");

    // The headline assertion. Paprika writes ONE <div itemprop="recipeInstructions">
    // holding N <p class="line">, so the generic microdata reader returns a single
    // unpunctuated run-on paragraph. ≥4 separate steps is the difference between a
    // cookable recipe and a wall of text.
    expect(recipe.instructions?.length).toBeGreaterThanOrEqual(4);
    expect(recipe.instructions?.[0]).toBe("Preheat the oven to 250 degrees.");
    expect(recipe.instructions?.at(-1)).toContain("Sprinkle with parsley.");
  });

  it("never mashes the whole method into one step", () => {
    const { recipe } = parsed("beef-bourguignon");

    // The precise failure mode: one element containing both the first and last sentence.
    // Asserting on the count alone would pass a parser that split on the wrong thing.
    for (const step of recipe.instructions ?? []) {
      expect(step.includes("Preheat the oven") && step.includes("Sprinkle with parsley")).toBe(false);
    }
  });

  it("splits every fixture, including the ones with no notes or image", () => {
    for (const name of ["air-fryer-chicken-parmesan", "arroz-con-pollo", "apple-bourbon-bundt-cake", "sourdough-discard-biscuits"]) {
      expect(parsed(name).recipe.instructions?.length, name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("parsePaprikaRecipe — the shared crosswalk (§4.1 note 2)", () => {
  it("reads ingredients one per line, quantities included", () => {
    const { recipe } = parsed("beef-bourguignon");

    expect(recipe.ingredients?.[0]).toBe("1 tablespoon good olive oil");
    expect(recipe.ingredients?.length).toBe(21);
  });

  it("passes recipeYield through verbatim, prose or number", () => {
    expect(parsed("beef-bourguignon").recipe.recipeYield).toBe("Serves 6");
    expect(parsed("apple-bourbon-bundt-cake").recipe.recipeYield).toBe("Yield 10 to 12 servings");
    expect(parsed("arroz-con-pollo").recipe.recipeYield).toBe("4");
  });

  it("converts a human duration to ISO on the shared normalizer", () => {
    expect(parsed("air-fryer-chicken-parmesan").recipe.totalTime).toBe("PT45M");
  });

  it("joins the comment paragraphs into notes with a blank line between them", () => {
    const { notes } = parsed("beef-bourguignon");

    expect(notes?.split("\n\n")).toHaveLength(3);
    expect(notes?.startsWith("Don’t wash the mushrooms")).toBe(true);
  });

  it("leaves notes null when the export has no comment block", () => {
    expect(parsed("arroz-con-pollo").notes).toBeNull();
  });
});

describe("parsePaprikaRecipe — tags (§12.3)", () => {
  it("splits recipeCategory on comma and keeps multi-word tags whole", () => {
    expect(parsed("arroz-con-pollo").tags).toEqual(["Export to Weeknight dinner", "Healthish", "Low Calorie"]);
    expect(parsed("air-fryer-chicken-parmesan").tags).toEqual(["High Protein"]);
  });

  it("carries the split tags into the record as keywords, not as a comma blob", () => {
    const { recipe } = parsed("arroz-con-pollo");

    expect(recipe.keywords).toEqual(["Export to Weeknight dinner", "Healthish", "Low Calorie"]);
    expect(recipe.vocab?.category).toBe("Export to Weeknight dinner");
  });
});

describe("parsePaprikaRecipe — source (§4.1 note 5)", () => {
  it("takes sourceUrl from the wrapping <a href> and sourceText as the domain beside it", () => {
    const candidate = parsed("air-fryer-chicken-parmesan");

    expect(candidate.sourceUrl).toBe(
      "https://cooking.nytimes.com/recipes/1022924-air-fryer-chicken-parmesan?action=click&module=Collection%20Page%20Recipe%20Card&region=Our%20Best%20Chicken%20Breast%20Recipes&pgType=collection&rank=9",
    );
    expect(candidate.sourceText).toBe("cooking.nytimes.com");
  });

  it("returns a null sourceUrl with a non-null free-text sourceText for the 24% with no URL", () => {
    const candidate = parsed("arroz-con-pollo");

    // The pair the §8 attribution step keys off: null URL is the signal, and the free text
    // is a book/blog reference, never a person.
    expect(candidate.sourceUrl).toBeNull();
    expect(candidate.sourceText).toBe("SkinnyTaste One and DOne");
  });
});

describe("parsePaprikaRecipe — images (§4.1 note 4)", () => {
  it("takes imageUrl from the wrapping <a href>, never from the <img src>", () => {
    const { imageUrl } = parsed("beef-bourguignon");

    expect(imageUrl).toBe("https://d14iv1hjmfkv57.cloudfront.net/assets/recipes/beef-bourguinon/_600x600_crop_center-center_61_line/144290/IMG_3904.jpg");
    expect(imageUrl).not.toContain("Images/");
  });

  it("returns the resolved localImagePath, a key the entry source actually holds", async () => {
    // The regression test for the whole note: the bug produces a plausible-looking path
    // (`Images/<uuid>/<uuid>.jpg`) that simply is not in the source, so this asserts against
    // the source's own key set rather than a string literal — a literal would be just as
    // wrong as the bug and the test would still pass.
    const html = fixture("beef-bourguignon");
    const imagePath = "Outer/My Recipes/Recipes/Images/0487E969-47F4-408F-997B-FF96619C99F5/6D5FBF91-007E-4378-A479-D838D463903A.jpg";
    const source = memoryEntrySource(
      new Map<string, string | Uint8Array>([
        ["Outer/My Recipes/index.html", "<html></html>"],
        ["Outer/My Recipes/Recipes/Beef Bourguignon.html", html],
        [imagePath, new Uint8Array([0xff, 0xd8, 0xff])],
      ]),
    );

    // Go through the walker so `sourcePath` is whatever it really produces, not a guess.
    const entries: ImportEntry[] = [];
    for await (const entry of walkPaprikaExport(source)) entries.push(entry);
    expect(entries).toHaveLength(1);

    const result = parsePaprikaRecipe(entries[0].html, entries[0]);
    if (isParseFailure(result)) throw new Error(result.message);

    expect(result.localImagePath).not.toBeNull();
    expect(source.paths()).toContain(result.localImagePath);
    await expect(source.bytes(result.localImagePath as string)).resolves.toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it("keeps the local path when the photo has no remote original (href='#')", () => {
    // A user-added photo: Paprika writes `<a href="#">`. That is a null imageUrl and a
    // perfectly good local preview, not a parse error.
    const candidate = parsed("sourdough-discard-biscuits");

    expect(candidate.imageUrl).toBeNull();
    expect(candidate.localImagePath).toBe(
      "Outer/My Recipes/Recipes/Images/917665A9-161F-43B4-8D97-685FA8F9AB97-32039-000006BBA6375A1F/D96772F6-528F-41FE-92A2-E98B6A36B5BB-32039-000006BC20CCC2AA.jpg",
    );
  });

  it("leaves both image fields null for the 91 recipes with no photo", () => {
    const candidate = parsed("arroz-con-pollo");

    expect(candidate.imageUrl).toBeNull();
    expect(candidate.localImagePath).toBeNull();
    expect(candidate.meta.photo_uid).toBeNull();
  });

  it("drops a path that escapes the drop rather than failing the recipe", () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe">
      <h1 itemprop="name">Escapee</h1>
      <p class="line" itemprop="recipeIngredient">1 cup flour</p>
      <a href="https://example.com/p.jpg"><img itemprop="image" src="../../../../etc/passwd"></a>
    </div>`;
    const result = parsePaprikaRecipe(html, { entryName: "Recipes/x.html", sourcePath: "Recipes/x.html", html });
    if (isParseFailure(result)) throw new Error(result.message);

    // One blank thumbnail is the right cost; losing the recipe is not.
    expect(result.localImagePath).toBeNull();
    expect(result.recipe.name).toBe("Escapee");
  });
});

describe("parsePaprikaRecipe — meta (§4.1, §12.4, §12.5)", () => {
  it("reads the rating from the value attribute, not the element text", () => {
    // The element is `<p itemprop="aggregateRating" class="rating" value="5"></p>` — empty
    // text. Anything reading `.text` gets null for every rated recipe in the export.
    expect(parsed("sourdough-discard-biscuits").meta.rating).toBe(5);
  });

  it("maps an unrated 0 to null", () => {
    expect(parsed("beef-bourguignon").meta.rating).toBeNull();
  });

  it("keeps difficulty verbatim and null when absent", () => {
    expect(parsed("sourdough-discard-biscuits").meta.difficulty).toBe("Medium");
    expect(parsed("beef-bourguignon").meta.difficulty).toBeNull();
  });

  it("records the photo-asset UUID — the Images/<uuid>/ directory, not the file", () => {
    expect(parsed("beef-bourguignon").meta.photo_uid).toBe("0487E969-47F4-408F-997B-FF96619C99F5");
  });

  it("preserves the unparseable duration verbatim in raw (§3.4)", () => {
    const candidate = parsed("apple-bourbon-bundt-cake");
    const raw = candidate.meta.raw as Record<string, unknown>;

    // We deliberately do NOT build a fraction-aware duration parser. `toIsoDuration` keeps
    // whichever number its regex finds and drops the prose, so the original string is the
    // only lossless record of what the user actually wrote.
    expect(raw.cook_time).toBe("1 1/2 hours plus cooling time");
    expect(candidate.recipe.cookTime).toMatch(/^PT/);
    expect(candidate.recipe.cookTime).not.toContain("cooling");
  });

  it("writes exactly the §4.1 key set", () => {
    expect(Object.keys(parsed("beef-bourguignon").meta).sort()).toEqual(["categories", "difficulty", "photo_uid", "rating", "raw"]);
  });

  it("never uses one of the four pipeline-reserved keys (§12.5)", () => {
    // The importer's keys and the pipeline's share one `ns='import'` key space, and the
    // commit boundary rejects an item that collides. Asserting it here keeps the constraint
    // live instead of a comment someone edits past.
    const reserved = ["importer", "session_id", "entry_name", "source_text"];
    for (const name of ["beef-bourguignon", "air-fryer-chicken-parmesan", "arroz-con-pollo", "apple-bourbon-bundt-cake", "sourdough-discard-biscuits"]) {
      const meta = parsed(name).meta;
      for (const key of reserved) expect(Object.keys(meta), `${name}.meta`).not.toContain(key);
      for (const key of reserved) expect(Object.keys(meta.raw as object), `${name}.meta.raw`).not.toContain(key);
    }
  });

  it("is JSON-clonable, because it crosses a worker boundary and lands in jsonb", () => {
    const meta = parsed("sourdough-discard-biscuits").meta;

    expect(structuredClone(meta)).toEqual(meta);
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});

describe("parsePaprikaRecipe — provenance and failures", () => {
  it("carries the entry's human-facing name onto the candidate", () => {
    expect(parsed("beef-bourguignon").entryName).toBe("Recipes/beef-bourguignon.html");
  });

  it("mints a fresh client id per call", () => {
    const a = parsed("beef-bourguignon").clientId;
    const b = parsed("beef-bourguignon").clientId;

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("reports a file with no recipe as a failure, tagged with the entry name", () => {
    const entry: ImportEntry = { entryName: "Recipes/Broken.html", sourcePath: "Recipes/Broken.html", html: "<html><body><p>not a recipe</p></body></html>" };
    const result = parsePaprikaRecipe(entry.html, entry);

    // A failure row, never a throw: `parse()` runs over a few hundred files and one bad
    // file must cost one line in the failure list, not the batch (§7.2).
    expect(isParseFailure(result)).toBe(true);
    expect(result.entryName).toBe("Recipes/Broken.html");
    expect(result.clientId).toBeTruthy();
  });

  it("reports a recipe with a name but no body as a failure", () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe"><h1 itemprop="name">Just A Title</h1></div>`;
    const result = parsePaprikaRecipe(html, { entryName: "Recipes/Title.html", sourcePath: "Recipes/Title.html", html });

    expect(isParseFailure(result)).toBe(true);
    if (isParseFailure(result)) expect(result.message).toContain("Just A Title");
  });
});
