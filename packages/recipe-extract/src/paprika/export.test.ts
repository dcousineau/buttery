import { describe, expect, it } from "vitest";
import { memoryEntrySource } from "../import/entry-source.ts";
import type { EntrySource, ImportEntry } from "../import/types.ts";
import { PaprikaExportError, walkPaprikaExport } from "./export.ts";
import { paprikaImporter } from "./importer.ts";

/** Everything here runs against the in-memory stub that lives beside the `EntrySource`
 *  interface (§4.3) — no filesystem, no `File`, no DOM — so these tests describe the walker
 *  and nothing else. The guardrails (size caps, path escape) are the entry source's and are
 *  tested there. */
function source(paths: string[]): EntrySource {
  return memoryEntrySource(new Map<string, string | Uint8Array>(paths.map((path) => [path, `<html><!-- ${path} --></html>`])));
}

async function walk(src: EntrySource): Promise<ImportEntry[]> {
  const out: ImportEntry[] = [];
  for await (const entry of walkPaprikaExport(src)) out.push(entry);
  return out;
}

async function names(paths: string[]): Promise<string[]> {
  return (await walk(source(paths))).map((entry) => entry.entryName);
}

describe("walkPaprikaExport — root detection (§4.2)", () => {
  it("treats the directory holding index.html as the root when the export itself was dropped", async () => {
    expect(await names(["index.html", "Recipes/Foo.html", "Recipes/Bar.html"])).toEqual(["Recipes/Bar.html", "Recipes/Foo.html"]);
  });

  it("finds the root one level down", async () => {
    const entries = await walk(source(["My Recipes/index.html", "My Recipes/Recipes/Foo.html"]));

    expect(entries).toHaveLength(1);
    expect(entries[0].entryName).toBe("Recipes/Foo.html");
    expect(entries[0].sourcePath).toBe("My Recipes/Recipes/Foo.html");
  });

  it("finds the root two levels down", async () => {
    const entries = await walk(source(["Outer/My Recipes/index.html", "Outer/My Recipes/Recipes/Foo.html"]));

    expect(entries[0].entryName).toBe("Recipes/Foo.html");
    expect(entries[0].sourcePath).toBe("Outer/My Recipes/Recipes/Foo.html");
  });

  it("never assumes the folder is called 'My Recipes'", async () => {
    // The export folder is whatever the user saved it as; hardcoding the default name is
    // the obvious shortcut and it breaks on the first renamed export (§3.1).
    const entries = await walk(source(["Downloads/paprika-2026-08-09/index.html", "Downloads/paprika-2026-08-09/Recipes/Foo.html"]));

    expect(entries[0].sourcePath).toBe("Downloads/paprika-2026-08-09/Recipes/Foo.html");
  });

  it("falls back to the shallowest directory containing a Recipes folder when index.html is missing", async () => {
    // §3.4: index.html is a convenience listing. A user who deleted it, or a drop that lost
    // it, should still import — the recipes are walked directly either way.
    const entries = await walk(source(["Outer/Export/Recipes/Foo.html", "Outer/Export/Recipes/Images/a/b.jpg"]));

    expect(entries.map((e) => e.entryName)).toEqual(["Recipes/Foo.html"]);
    expect(entries[0].sourcePath).toBe("Outer/Export/Recipes/Foo.html");
  });

  it("prefers the shallowest index.html when a drop contains more than one", async () => {
    const entries = await walk(source(["Export/index.html", "Export/Recipes/Foo.html", "Export/Recipes/Images/x/index.html"]));

    expect(entries.map((e) => e.entryName)).toEqual(["Recipes/Foo.html"]);
  });

  it("rejects a drop that is not an export at all", async () => {
    await expect(walk(source(["notes.txt", "photos/cat.jpg"]))).rejects.toBeInstanceOf(PaprikaExportError);
    await expect(walk(source(["notes.txt"]))).rejects.toMatchObject({ code: "no_export_root" });
  });
});

describe("walkPaprikaExport — entry filtering (§4.2)", () => {
  it("yields Recipes/*.html and nothing else", async () => {
    const entries = await names([
      "My Recipes/index.html",
      "My Recipes/Recipes/Alpha.html",
      "My Recipes/Recipes/Beta.html",
      "My Recipes/Recipes/index.html", // a listing, never a recipe
      "My Recipes/Recipes/Images/1234/5678.jpg", // 250 photo dirs — would fail 250 times
      "My Recipes/Recipes/Images/1234/thumb.html", // still under Images/, still not a recipe
      "My Recipes/Recipes/notes.txt",
      "My Recipes/README.md",
      "My Recipes/__MACOSX/Recipes/Alpha.html",
      "My Recipes/Recipes/.DS_Store",
      "My Recipes/Recipes/._Alpha.html", // AppleDouble resource fork, not HTML
      "Unrelated/Recipes/Gamma.html", // outside the detected root
    ]);

    expect(entries).toEqual(["Recipes/Alpha.html", "Recipes/Beta.html"]);
  });

  it("keeps entryName and sourcePath differing by exactly the root prefix", async () => {
    // The invariant §4.1 note 4's image resolution depends on: sibling assets resolve
    // against sourcePath, never against entryName.
    const entries = await walk(source(["A/B/index.html", "A/B/Recipes/Foo.html"]));

    expect(entries[0].sourcePath).toBe(`A/B/${entries[0].entryName}`);
  });

  it("yields in a stable, sorted order regardless of the source's path order", async () => {
    const forward = await names(["r/index.html", "r/Recipes/A.html", "r/Recipes/B.html", "r/Recipes/C.html"]);
    const reversed = await names(["r/Recipes/C.html", "r/Recipes/B.html", "r/index.html", "r/Recipes/A.html"]);

    // `EntrySource.paths()` promises no order, and a failure list that reshuffles between
    // runs is not reproducible.
    expect(forward).toEqual(reversed);
  });
});

describe("walkPaprikaExport — laziness (§4.2)", () => {
  it("reads a recipe's bytes only when its entry is consumed", async () => {
    const base = source(["r/index.html", "r/Recipes/A.html", "r/Recipes/B.html", "r/Recipes/C.html"]);
    const reads: string[] = [];
    const spied: EntrySource = { ...base, text: async (path) => (reads.push(path), base.text(path)) };

    const iterator = walkPaprikaExport(spied)[Symbol.asyncIterator]();
    await iterator.next();

    // Slurping all 341 files up front would freeze the UI and then report "done" instantly;
    // the progress bar in the design only tells the truth if this stays lazy (§9).
    expect(reads).toEqual(["r/Recipes/A.html"]);
    await iterator.next();
    expect(reads).toEqual(["r/Recipes/A.html", "r/Recipes/B.html"]);
  });
});

describe("paprikaImporter", () => {
  it("identifies itself with the id stored on the session and the sidecar", () => {
    expect(paprikaImporter.id).toBe("paprika");
    expect(paprikaImporter.label).toBe("Paprika 3");
  });

  it("carries the drop copy the launch screen renders (§9, D19)", () => {
    // The one Paprika fact the shipped UI is allowed to state, and it has to state it:
    // Paprika writes a folder, not a single file, so a user hunting for one file stalls.
    expect(paprikaImporter.dropCopy.heading).toBe("Drop your exported recipe folder here");
    expect(paprikaImporter.dropCopy.help.steps.at(-1)).toContain("writes a folder, not a single file");
    expect(paprikaImporter.dropCopy.lede).toContain("{household}");
    expect(paprikaImporter.dropCopy.help.links).toHaveLength(2);
  });

  it("wires entries() and parse() to the walker and the parser", async () => {
    const html = `<div itemscope itemtype="http://schema.org/Recipe">
      <h1 itemprop="name">Toast</h1>
      <p class="line" itemprop="recipeIngredient">1 slice bread</p>
      <div itemprop="recipeInstructions"><p class="line">Toast it.</p><p class="line">Eat it.</p></div>
    </div>`;
    const src = memoryEntrySource(
      new Map<string, string | Uint8Array>([
        ["Box/index.html", "<html></html>"],
        ["Box/Recipes/Toast.html", html],
      ]),
    );

    const entries: ImportEntry[] = [];
    for await (const entry of paprikaImporter.entries(src)) entries.push(entry);
    const result = paprikaImporter.parse(entries[0]);

    expect(entries.map((e) => e.entryName)).toEqual(["Recipes/Toast.html"]);
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") expect(result.recipe.instructions).toEqual(["Toast it.", "Eat it."]);
  });
});
