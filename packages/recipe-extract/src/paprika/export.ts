import type { EntrySource, ImportEntry } from "../import/types.ts";

/**
 * The layout facts this walker encodes, all of them Paprika's (§3.1):
 *
 * ```
 * <root>/index.html          a convenience listing, not the source of truth
 * <root>/Recipes/*.html      one recipe per file
 * <root>/Recipes/Images/…    photo assets, 1:1 with images, never a recipe
 * ```
 *
 * The size and path-escape guardrails deliberately are **not** here: they are properties of
 * "a pile of files a user handed us" and live on the entry source, so every future importer
 * inherits them (§4.2). Root detection is the half that is genuinely Paprika's and stays.
 */
const RECIPES_DIR = "recipes";
const INDEX_FILE = "index.html";

/** The drop is not a Paprika export. Carries a `code` so the launch screen can pick its own
 *  copy without string-matching a message, matching `EntrySourceError`'s contract. */
export class PaprikaExportError extends Error {
  constructor(
    public readonly code: "no_export_root",
    message: string,
  ) {
    super(message);
    this.name = "PaprikaExportError";
  }
}

/**
 * Walk an `EntrySource` and yield one `ImportEntry` per recipe file (§4.2).
 *
 * **Lazy on purpose.** Each entry's bytes are read only when the consumer asks for the next
 * one, which is what lets the UI show honest progress across a few hundred files instead of
 * freezing on a 15 MB slurp and then finishing instantly (§9).
 *
 * @throws {PaprikaExportError} when no export root can be found.
 */
export async function* walkPaprikaExport(source: EntrySource): AsyncIterable<ImportEntry> {
  const paths = source.paths();
  const root = detectRoot(paths);
  // `""` (the user dropped the export root itself) must not become a stray leading "/".
  const prefix = root === "" ? "" : `${root}/`;

  // Sorted so progress runs alphabetically and a failure list is reproducible;
  // `EntrySource.paths()` guarantees no order of its own.
  for (const path of [...paths].sort()) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (!isRecipeFile(relative)) continue;
    yield {
      // Root-relative, per §4.2: `entryName` and `sourcePath` "differ by exactly the
      // detected root prefix". That invariant is what makes §4.1 note 4's resolution
      // checkable, so it wins over the plan's shorthand examples, which show a bare
      // basename.
      entryName: relative,
      sourcePath: path,
      html: await source.text(path),
    };
  }
}

/**
 * Locate the export root (§4.2). The user may drop the export folder itself or any parent of
 * it, and the folder's name is whatever they saved it as — **never hardcode `My Recipes/`**.
 *
 * Shallowest `index.html` wins, because that is the one file Paprika always writes at the
 * root. The fallback — shallowest directory holding a `Recipes/` folder — covers a user who
 * dragged only part of the export or whose `index.html` was tidied away; §3.4 already says
 * `index.html` is a convenience listing and the recipes are walked directly regardless.
 *
 * Ties break lexicographically so a drop containing two exports resolves to the same one on
 * every run, whatever order `paths()` came back in.
 */
function detectRoot(paths: readonly string[]): string {
  const byIndex: string[] = [];
  const byRecipesDir: string[] = [];

  for (const path of paths) {
    if (isNoise(path)) continue;
    const segments = path.split("/");
    const basename = segments.at(-1) ?? "";
    if (basename.toLowerCase() === INDEX_FILE) byIndex.push(segments.slice(0, -1).join("/"));

    // Directories are implicit in a flat path list, so "contains a `Recipes/` folder" is
    // read off any file inside one. `-1` cannot match: the last segment is the file itself.
    const at = segments.findIndex((segment, i) => i < segments.length - 1 && segment.toLowerCase() === RECIPES_DIR);
    if (at >= 0) byRecipesDir.push(segments.slice(0, at).join("/"));
  }

  const root = shallowest(byIndex) ?? shallowest(byRecipesDir);
  if (root == null) {
    throw new PaprikaExportError("no_export_root", "That folder does not look like a Paprika export: no index.html and no Recipes folder was found inside it.");
  }
  return root;
}

function shallowest(candidates: string[]): string | null {
  if (!candidates.length) return null;
  return candidates.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

/**
 * Root-relative path → is this one recipe?
 *
 * Requires exactly `Recipes/<name>.html`, which is what excludes `Recipes/Images/**` — 250
 * photo directories that would otherwise be parsed as recipes and fail 250 times — without
 * naming `Images` at all. `index.html` is excluded explicitly (§3.4: it is a listing).
 */
function isRecipeFile(relative: string): boolean {
  if (isNoise(relative)) return false;
  const segments = relative.split("/");
  if (segments.length !== 2) return false;
  if (segments[0].toLowerCase() !== RECIPES_DIR) return false;
  const basename = segments[1].toLowerCase();
  return basename !== INDEX_FILE && (basename.endsWith(".html") || basename.endsWith(".htm"));
}

/** macOS archive/Finder debris. `._Foo.html` is an AppleDouble resource fork: it is not
 *  HTML, it is byte-for-byte metadata, and parsing it produces a confusing failure row. */
function isNoise(path: string): boolean {
  return path.split("/").some((segment) => segment === "__MACOSX" || segment === ".DS_Store" || segment.startsWith("._"));
}
