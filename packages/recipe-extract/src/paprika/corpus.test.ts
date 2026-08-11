import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { memoryEntrySource } from "../import/entry-source.ts";
import { isParseFailure, type EntrySource, type ImportCandidate, type ImportParseFailure } from "../import/types.ts";
import { walkPaprikaExport } from "./export.ts";
import { parsePaprikaRecipe } from "./recipe.ts";

/**
 * The whole-corpus test for acceptance criterion §16.2 — "all 341 recipes in the
 * reference export parse without error; instructions arrive as separate steps,
 * never one run-on paragraph".
 *
 * ── WHY THIS EXISTS ALONGSIDE `recipe.test.ts` ───────────────────────────
 * `recipe.test.ts` pins five real files, chosen because each one carries a quirk
 * worth naming. That is the right way to test a parser and the wrong way to
 * verify a claim about 341 files: the failure mode §16.2 guards against is the
 * 342nd shape nobody thought to commit a fixture for — an entry with no
 * `<itemtype>`, an image path that resolves one directory too high, a recipe
 * whose instructions are a single `<p>` after an app update. Five fixtures
 * cannot see any of that. Only the corpus can.
 *
 * ── WHY IT IS OPT-IN ─────────────────────────────────────────────────────
 * The export is 15 MB of one person's recipe box. It is not committed, it never
 * will be, and CI does not have it. So this suite **skips with a message** when
 * the folder is absent — the same contract the web app's `*.db.test.ts` suites
 * hold to for a database: never fail for the absence of something the machine
 * was never promised. Point it anywhere with `PAPRIKA_EXPORT_DIR`.
 *
 * ── NO PRODUCTION CHANGE WAS NEEDED ──────────────────────────────────────
 * `walkPaprikaExport` takes an `EntrySource`, not a `File[]`, and
 * `memoryEntrySource` is already the shipped, exported, DOM-free implementation
 * of that interface (it runs the same `normalizeEntryPath` and the same
 * guardrails as `directoryEntrySource`). Reading a directory into a `Map` is
 * therefore a dozen lines of `node:fs` in this file — the importer's public API
 * is untouched, and nothing Node-only ships.
 */

// --- locating the export -------------------------------------------------

/**
 * `PAPRIKA_EXPORT_DIR` first, then the default macOS location relative to the
 * home directory. Built from `homedir()` rather than hardcoded so the path is
 * a convention, not one developer's machine.
 */
function findExportDir(): string | null {
  const candidates = [process.env.PAPRIKA_EXPORT_DIR, join(homedir(), "Documents", "My Recipes")].filter((v): v is string => !!v);
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // not there; try the next
    }
  }
  return null;
}

const EXPORT_DIR = findExportDir();

if (!EXPORT_DIR) {
  process.stderr.write(
    `\nSKIPPING the Paprika corpus test — no export folder found.\n` +
      `This suite walks a real Paprika 3 export end to end (§16.2); it is opt-in because the\n` +
      `export is 15 MB of personal data that is not, and will not be, in the repo.\n` +
      `Point it at one with PAPRIKA_EXPORT_DIR=/path/to/My\\ Recipes.\n\n`,
  );
}

// --- reading the export into the shipped EntrySource ---------------------

/** Every file under `dir`, as paths relative to `dir` with `/` separators. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

/**
 * The export, as the browser would have handed it over.
 *
 * Deliberately prefixed with the folder's own name: the user drops the export
 * folder, so every `EntrySource` key is `My Recipes/…` and the walker has to
 * *detect* the root rather than assume it. Keying on the bare relative path
 * would quietly test an easier problem than the one §4.2 solves, and would make
 * the `localImagePath` assertion below — which is entirely about §4.1 note 4's
 * two-hop resolution — pass without resolving anything.
 */
function readExport(dir: string): { source: EntrySource; dropName: string; htmlCount: number } {
  const dropName = dir.split(sep).filter(Boolean).at(-1) ?? "export";
  const entries = new Map<string, string | Uint8Array>();
  let htmlCount = 0;
  for (const rel of listFiles(dir)) {
    const key = `${dropName}/${rel}`;
    const isHtml = /\.html?$/i.test(rel);
    // Bytes for assets, text for HTML — the same two accessors the real source
    // exposes, so the parse path sees exactly what the app's would.
    entries.set(key, isHtml ? readFileSync(join(dir, rel), "utf8") : new Uint8Array(readFileSync(join(dir, rel))));
    if (isHtml) htmlCount += 1;
  }
  return { source: memoryEntrySource(entries), dropName, htmlCount };
}

/** `<div itemprop="recipeInstructions">` holding more than one `<p>` — the §4.1 note 1 shape. */
function instructionParagraphCount(html: string): number {
  const root = parseHtml(html);
  const scope = root.querySelector('[itemtype*="Recipe" i]') ?? root;
  return scope.querySelector('[itemprop="recipeInstructions"]')?.querySelectorAll("p").length ?? 0;
}

// --- the run -------------------------------------------------------------

const describeCorpus = EXPORT_DIR ? describe : describe.skip;

interface Walked {
  entryName: string;
  sourcePath: string;
  html: string;
  result: ImportCandidate | ImportParseFailure;
  thrown: unknown;
}

interface Corpus {
  dir: string;
  source: EntrySource;
  dropName: string;
  htmlCount: number;
  walked: Walked[];
  walkError: unknown;
}

/**
 * Read + walk + parse once for the whole suite, memoized and **lazy**.
 *
 * Lazy is load-bearing: `describe.skip` still evaluates its callback, so doing
 * any of this in the block body would crash a machine with no export — turning
 * "skip cleanly" into a red suite, which is the one thing this test must never
 * do. Test bodies do not run when skipped, so nothing here is reached.
 *
 * `parsePaprikaRecipe` is documented as total — a bad file is a `failure` row,
 * never a throw — so a throw is captured rather than allowed to abort the walk.
 * That is what lets the assertions report *which* entry broke.
 */
let corpus: Promise<Corpus> | null = null;
function load(): Promise<Corpus> {
  corpus ??= (async (): Promise<Corpus> => {
    const dir = EXPORT_DIR!;
    const { source, dropName, htmlCount } = readExport(dir);
    const walked: Walked[] = [];
    let walkError: unknown = null;
    try {
      for await (const entry of walkPaprikaExport(source)) {
        let result: ImportCandidate | ImportParseFailure | undefined;
        let thrown: unknown = null;
        try {
          result = parsePaprikaRecipe(entry.html, entry);
        } catch (err) {
          thrown = err;
        }
        walked.push({ entryName: entry.entryName, sourcePath: entry.sourcePath, html: entry.html, result: result!, thrown });
      }
    } catch (err) {
      walkError = err;
    }
    return { dir, source, dropName, htmlCount, walked, walkError };
  })();
  return corpus;
}

const candidatesOf = (walked: Walked[]): ImportCandidate[] => walked.map((w) => w.result).filter((r): r is ImportCandidate => !!r && !isParseFailure(r));

describeCorpus("the whole reference export parses (§16.2)", () => {
  it("walks every recipe file in the export and nothing else", async () => {
    const { dir, dropName, htmlCount, walked, walkError } = await load();
    expect(walkError).toBeNull();

    // `Recipes/*.html`, minus `index.html`, is the walker's contract (§3.1/§4.2).
    // Counted off the filesystem rather than hardcoded to 341, so the assertion
    // stays true if the box grows — and still fails if the walker starts
    // dropping files or picking up `Recipes/Images/**`.
    const onDisk = readdirSync(join(dir, "Recipes"), { withFileTypes: true }).filter((e) => e.isFile() && /\.html?$/i.test(e.name) && e.name.toLowerCase() !== "index.html").length;

    expect(walked.length).toBe(onDisk);
    expect(walked.length).toBeGreaterThan(0);
    // The export holds more HTML than it holds recipes — at minimum the root
    // `index.html`, which §3.4 says is a listing and must never be parsed as a
    // recipe. Every walked entry is a `Recipes/<name>.html` and none is it.
    expect(htmlCount).toBeGreaterThan(walked.length);
    for (const w of walked) expect(w.entryName).toMatch(/^Recipes\/[^/]+\.html?$/i);
    expect(walked.some((w) => /(^|\/)index\.html$/i.test(w.entryName))).toBe(false);

    // §4.2's invariant: the two paths differ by exactly the detected root prefix.
    for (const w of walked) expect(w.sourcePath).toBe(`${dropName}/${w.entryName}`);
  });

  it("parses every entry without throwing", async () => {
    const { walked } = await load();
    const threw = walked.filter((w) => w.thrown != null).map((w) => `${w.entryName}: ${String(w.thrown)}`);
    expect(threw).toEqual([]);
  });

  it("produces zero parse failures across the corpus", async () => {
    const { walked } = await load();
    const failures = walked
      .map((w) => w.result)
      .filter((r): r is ImportParseFailure => !!r && isParseFailure(r))
      .map((f) => `${f.entryName}: ${f.message}`);

    // Listed, not counted: a regression here should name the recipes it broke.
    expect(failures).toEqual([]);
  });

  it("gives every candidate a name and a body", async () => {
    const { walked } = await load();
    const empty = candidatesOf(walked)
      .filter((c) => !c.recipe.name?.trim() || (!c.recipe.ingredients?.length && !c.recipe.instructions?.length))
      .map((c) => c.entryName);
    expect(empty).toEqual([]);
  });

  /**
   * §4.1 note 4. `localImagePath` is promised to be "directly passable to
   * `EntrySource.bytes()` with no further joining" — so the honest test is to
   * pass it, for every recipe that has one. A resolution that is off by one
   * directory produces a plausible-looking string and a blank thumbnail for
   * every image in the review screen, which is invisible to a fixture that
   * happens to sit at the same depth.
   */
  it("resolves every localImagePath to a key the source actually holds", async () => {
    const { source, walked } = await load();
    const withImage = candidatesOf(walked).filter((c) => c.localImagePath != null);
    expect(withImage.length).toBeGreaterThan(0); // the assertion below must not be vacuous

    const keys = new Set(source.paths());
    const missing = withImage.filter((c) => !keys.has(c.localImagePath!)).map((c) => `${c.entryName} → ${c.localImagePath}`);
    expect(missing).toEqual([]);

    // And readable, not merely present — `bytes()` is what the thumbnail calls.
    const first = withImage[0];
    await expect(source.bytes(first.localImagePath!)).resolves.toBeInstanceOf(Uint8Array);
  });

  /**
   * The headline §16.2 clause: "instructions arrive as separate steps, never one
   * run-on paragraph". Checked against each file's OWN markup rather than a flat
   * "everything has ≥2 steps" rule — a genuinely one-paragraph recipe exists and
   * must not be a failure. What must never happen is a file whose method is N
   * paragraphs coming back as one step.
   */
  it("splits every multi-paragraph instruction block into that many steps", async () => {
    const { walked } = await load();
    const collapsed: string[] = [];
    let multiParagraph = 0;

    for (const w of walked) {
      const paragraphs = instructionParagraphCount(w.html);
      if (paragraphs < 2) continue;
      multiParagraph += 1;
      const steps = !isParseFailure(w.result) ? (w.result.recipe.instructions?.length ?? 0) : 0;
      if (steps < 2) collapsed.push(`${w.entryName}: ${paragraphs} <p> → ${steps} step(s)`);
    }

    expect(multiParagraph).toBeGreaterThan(0); // the corpus really does exercise this
    expect(collapsed).toEqual([]);
  });

  /**
   * The §8 counting claim (§16.7) is about the same corpus and costs one pass:
   * every candidate is attributable from either a URL or a source string, or is
   * in the small "no source at all" group — never silently unattributed with no
   * way for the review screen to ask.
   */
  it("leaves every candidate attributable — a URL, a source string, or the explicit no-source group", async () => {
    const { walked } = await load();
    const all = candidatesOf(walked);
    const withUrl = all.filter((c) => c.sourceUrl);
    const urlless = all.filter((c) => !c.sourceUrl);
    const distinctSourceStrings = new Set(urlless.map((c) => c.sourceText?.trim()).filter((s): s is string => !!s));
    const noSourceAtAll = urlless.filter((c) => !c.sourceText?.trim());

    expect(withUrl.length + urlless.length).toBe(all.length);
    expect(withUrl.length).toBeGreaterThan(0);
    expect(urlless.length).toBeGreaterThan(0);

    // `sourceText` is genuinely read: all but a handful of the URL-less recipes
    // carry one. Without this floor, a parser that stopped reading it would look
    // *better* by the decision count below — every URL-less recipe would collapse
    // into the single "no source at all" group and the budget would read 1.
    expect(noSourceAtAll.length).toBeLessThanOrEqual(10);

    // Decisions the user is asked for: one per distinct source string, plus one
    // for the leftover group (§8.2). §16.7 budgets 29 for the reference export as
    // measured during planning; the ceiling is loosened to 40 so a grown recipe
    // box does not fail the suite, while a parser that stopped *grouping* — one
    // decision per recipe — blows straight through it.
    const decisions = distinctSourceStrings.size + (noSourceAtAll.length ? 1 : 0);
    expect(decisions).toBeLessThanOrEqual(40);
    expect(decisions).toBeLessThan(urlless.length);
  });
});
