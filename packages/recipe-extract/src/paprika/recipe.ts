import { parse, type HTMLElement } from "node-html-parser";
import type { WireRecipe } from "@buttery/recipe-schemas/schema-org";
import { schemaOrgToLexicon } from "@buttery/recipe-schemas/bridge";
import { readItem } from "../parse/microdata.ts";
import { normalizeEntryPath } from "../import/entry-source.ts";
import type { ImportCandidate, ImportEntry, ImportParseFailure, JsonObject } from "../import/types.ts";

/**
 * One Paprika 3 HTML export file → an `ImportCandidate` (§4.1).
 *
 * Pure, synchronous, no network, no DOM — it runs in a Web Worker over a few hundred files
 * (§9), so it must never touch a global the worker does not have.
 *
 * The export is schema.org microdata, so the bulk of the work is the shared
 * `readItem` + `schemaOrgToLexicon` crosswalk (§2.4, §4.1 note 2). What this module adds is
 * the handful of properties Paprika encodes in a shape the generic reader cannot see, each
 * of which is a documented data-loss bug if skipped:
 *
 *   - instructions live in sibling `<p>`s inside one container (note 1),
 *   - the rating lives in an attribute on an empty element (note 3),
 *   - the image's real URL is on the wrapping `<a>`, and its local path is relative to the
 *     recipe file rather than to the drop (note 4).
 *
 * Everything the lexicon has no home for — categories, rating, difficulty, the photo UID,
 * and verbatim copies of anything we mangled — goes to `meta`, which the pipeline carries
 * opaquely into the sidecar (§12.5). There is no intermediate `PaprikaParsed` type: a
 * converter between two shapes is a second place the instruction splitting could go wrong
 * for no gain (§2.5).
 */
export function parsePaprikaRecipe(html: string, entry: ImportEntry): ImportCandidate | ImportParseFailure {
  const clientId = crypto.randomUUID();
  try {
    return build(clientId, html, entry);
  } catch (err) {
    // A single malformed file must cost one row in the failure list, never the batch —
    // `parse()` is called in a loop over the whole export and the caller has no other
    // way to attribute a throw to an entry (§7.2, §10.1).
    return { kind: "failure", clientId, entryName: entry.entryName, message: err instanceof Error ? err.message : String(err) };
  }
}

function build(clientId: string, html: string, entry: ImportEntry): ImportCandidate | ImportParseFailure {
  const root = parse(html);
  // Same scoping rule as `fromMicrodata`: prefer the Recipe itemscope, fall back to the
  // document so a stripped-down export still parses.
  const scope = root.querySelector('[itemtype*="Recipe" i]') ?? root;

  const instructions = paragraphs(scope.querySelector('[itemprop="recipeInstructions"]'));
  const notes = paragraphs(scope.querySelector('[itemprop="comment"]'));
  const tags = splitCategories(text(scope.querySelector('[itemprop="recipeCategory"]')));
  const rating = readRating(scope.querySelector('[itemprop="aggregateRating"]'));
  const difficulty = text(scope.querySelector('[itemprop="difficulty"]'));
  const sourceUrl = remoteUrl(scope.querySelector('[itemprop="url"]')?.getAttribute("href"));
  // §4.1 note 5: this is the *domain* when `sourceUrl` is present and free text otherwise.
  // Never a person — mapping it to an author is the §8 mistake this comment exists to stop.
  const sourceText = text(scope.querySelector('[itemprop="author"]'));

  const image = readImage(scope, entry);

  const node = readItem(scope);
  // Everything read above is either encoded in a way the generic walker gets wrong or has
  // no schema.org meaning at all. Dropping the keys is what keeps `schemaOrgToLexicon` from
  // "helpfully" mapping them: `image` in particular would be absolutized against the source
  // URL and yield a remote address that has never existed.
  for (const key of ["recipeInstructions", "image", "url", "author", "comment", "aggregateRating", "difficulty", "recipeCategory"]) delete node[key];
  if (instructions.length) node.recipeInstructions = instructions;
  if (tags.length) {
    // Paprika's `recipeCategory` is personal tags, not a controlled vocabulary (§3.3), so
    // they ride into the record as `keywords` (§12.1/§12.3). The split array is also handed
    // over as `recipeCategory` so `vocab.category` is one tag rather than a comma-joined
    // blob — the pipeline decides which, if any, resolves to a real category.
    node.keywords = tags;
    node.recipeCategory = tags;
  }

  // `base` only ever resolves relative image URLs, and `image` is gone by now; passing the
  // source URL anyway keeps the call honest if the bridge grows another use for it.
  const recipe = schemaOrgToLexicon(node as WireRecipe, sourceUrl ?? "");
  if (image.imageUrl) recipe.imageUrl = image.imageUrl;

  // Same usability bar as `fromMicrodata`: a name plus some body. Below it we have a page,
  // not a recipe, and the user is better served by an honest entry in the failure list.
  if (!recipe.name) return fail(clientId, entry, "No recipe name found in this file.");
  if (!recipe.ingredients?.length && !recipe.instructions?.length) return fail(clientId, entry, `"${recipe.name}" has no ingredients and no instructions.`);

  return {
    kind: "candidate",
    clientId,
    recipe,
    sourceUrl,
    sourceText,
    notes: notes.length ? notes.join("\n\n") : null,
    tags,
    imageUrl: image.imageUrl,
    localImagePath: image.localImagePath,
    entryName: entry.entryName,
    meta: buildMeta({ tags, rating, difficulty, photoUid: image.photoUid, scope, imageSrc: image.src }),
  };
}

function fail(clientId: string, entry: ImportEntry, message: string): ImportParseFailure {
  return { kind: "failure", clientId, entryName: entry.entryName, message };
}

/**
 * The §4.1 key set, exactly. The pipeline never reads any of it (§12.4) — it writes one
 * `household_recipe_meta` row per key under `ns='import'` (§12.5) — so the shape here is a
 * promise to a *future* reader, not to a current one.
 *
 * None of these keys may collide with the four the pipeline owns (`importer`, `session_id`,
 * `entry_name`, `source_text`); they share one namespace and the commit boundary rejects an
 * item that reuses one (§12.5). There is a test asserting that, so the constraint is live
 * rather than aspirational.
 */
function buildMeta(input: { tags: string[]; rating: number | null; difficulty: string | null; photoUid: string | null; imageSrc: string | null; scope: HTMLElement }): JsonObject {
  const { tags, rating, difficulty, photoUid, imageSrc, scope } = input;

  // Verbatim copies of everything we mangled or dropped. The durations are the reason this
  // key exists: `toIsoDuration("1 1/2 hours plus cooling time")` returns `PT1H` and we have
  // decided not to fix that (§3.4), so the only honest thing is to keep the original.
  const raw: JsonObject = {};
  putIf(raw, "prep_time", text(scope.querySelector('[itemprop="prepTime"]')));
  putIf(raw, "cook_time", text(scope.querySelector('[itemprop="cookTime"]')));
  putIf(raw, "total_time", text(scope.querySelector('[itemprop="totalTime"]')));
  putIf(raw, "recipe_category", text(scope.querySelector('[itemprop="recipeCategory"]')));
  // The rewritten `<img src>`, kept because phase 2 uploads the export's own bytes (§17)
  // and will want the attribute as written, not our resolution of it.
  putIf(raw, "image_src", imageSrc);

  return { categories: tags, rating, difficulty, photo_uid: photoUid, raw };
}

function putIf(target: JsonObject, key: string, value: string | null): void {
  if (value != null) target[key] = value;
}

/* --- the four quirks ------------------------------------------------------ */

/**
 * §4.1 note 1, the headline bug. `recipeInstructions` is **one** `<div>` holding N
 * `<p class="line">`, so the generic `elementValue()` concatenates every step into a single
 * unpunctuated run-on paragraph — the most damaging thing this parser can do, and invisible
 * until a user tries to cook from it.
 *
 * Also used for `comment` (notes), which has the same one-container-many-paragraphs shape
 * and the same failure mode.
 *
 * Falls back to the container's own text when there are no `<p>` children, so a future
 * export layout degrades to today's blob rather than to nothing.
 */
function paragraphs(container: HTMLElement | null): string[] {
  if (!container) return [];
  const lines = container.querySelectorAll("p").map((p) => clean(p.text));
  const kept = lines.filter((line): line is string => line != null);
  if (kept.length) return kept;
  const whole = clean(container.text);
  return whole ? [whole] : [];
}

/**
 * §4.1 note 3. The element is `<p itemprop="aggregateRating" class="rating" value="0"></p>`
 * — empty text, value in a non-standard attribute the microdata spec has no rule for, so
 * the generic walker drops it (correctly). `0` is Paprika's "unrated", not a zero-star
 * review, and must not survive as a number.
 */
function readRating(el: HTMLElement | null): number | null {
  const raw = el?.getAttribute("value")?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

interface PaprikaImage {
  /** The original remote URL, from the wrapping `<a href>`. */
  imageUrl: string | null;
  /** Source-relative and directly passable to `EntrySource.bytes()`. */
  localImagePath: string | null;
  /** The `<img src>` exactly as written. */
  src: string | null;
  /** The photo-asset UUID — the `Images/<uuid>/` directory name (§3.5). */
  photoUid: string | null;
}

/**
 * §4.1 note 4, the second-most damaging bug. Two different values hide in one element:
 *
 *   `<a href="https://…/photo.jpg"><img src="Images/<uuid>/<uuid>.jpg" itemprop="image"></a>`
 *
 * The `href` is the original remote URL and is what the commit path stores (§11). The `src`
 * is a local path — **but relative to the recipe HTML file**, while `EntrySource` is keyed
 * relative to *whatever the user dropped*, which may be a parent of the export root (§3.1).
 * Storing the bare attribute makes `source.bytes()` miss on both axes and every review
 * thumbnail render blank, so both hops are resolved here, once, by the importer, using the
 * same normalizer the entry source itself uses.
 *
 * `href` is often `#` — a photo the user added themselves, with no remote original. That is
 * a null `imageUrl` and a perfectly good local path, not an error.
 */
function readImage(scope: HTMLElement, entry: ImportEntry): PaprikaImage {
  const img = scope.querySelector('img[itemprop="image"]');
  if (!img) return { imageUrl: null, localImagePath: null, src: null, photoUid: null };

  const src = clean(img.getAttribute("src"));
  return {
    imageUrl: remoteUrl(anchorHref(img, scope)),
    localImagePath: src ? resolveSibling(entry.sourcePath, src) : null,
    src,
    photoUid: src ? photoUid(src) : null,
  };
}

/** The nearest wrapping `<a href>` within the recipe scope. Walked by hand rather than with
 *  `closest()` so it can be bounded by `scope` — an unwrapped `<img>` must not pick up some
 *  unrelated ancestor link from the page chrome. */
function anchorHref(el: HTMLElement, scope: HTMLElement): string | undefined {
  let node: HTMLElement | null = el.parentNode;
  while (node && node !== scope.parentNode) {
    if (node.tagName?.toLowerCase() === "a") return node.getAttribute("href");
    node = node.parentNode;
  }
  return undefined;
}

/**
 * `Recipes/Foo.html` + `Images/<uuid>/<uuid>.jpg` → `Recipes/Images/<uuid>/<uuid>.jpg`,
 * prefixed by however deep the drop was. Returns null rather than throwing when the export
 * points somewhere it should not: a hostile `src` costs one missing thumbnail, not the
 * recipe (`normalizeEntryPath` throws on escape, and that throw would otherwise reach the
 * whole-file catch).
 */
function resolveSibling(sourcePath: string, src: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null; // already a URL, not a path
  const dir = sourcePath.split("/").slice(0, -1).join("/");
  try {
    return normalizeEntryPath(dir ? `${dir}/${src}` : src);
  } catch {
    return null;
  }
}

/** `Images/<uuid>/<uuid>.jpg` → the directory UUID, which is the photo asset id (§3.5).
 *  A weak, ~73%-coverage key: never a primary dedupe key, only a re-import tie-breaker. */
function photoUid(src: string): string | null {
  const segments = src.split("/").filter(Boolean);
  return segments.length >= 2 ? (segments.at(-2) ?? null) : null;
}

/* --- small shared helpers ------------------------------------------------- */

function text(el: HTMLElement | null | undefined): string | null {
  return el ? clean(el.text) : null;
}

function clean(value: string | null | undefined): string | null {
  const s = value?.replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/** Only an absolute http(s) URL is usable as provenance or as an image source. Paprika
 *  writes `#` for user-supplied photos and can write nothing at all for hand-entered
 *  recipes (24% of the reference export, §3.3). */
function remoteUrl(value: string | null | undefined): string | null {
  const s = clean(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    // Returned verbatim, not `url.toString()`: canonicalization belongs to
    // `normalizeSourceUrl` at dedupe time (§6.1), and the value the user sees in review
    // should be the one their export actually holds.
    return url.protocol === "http:" || url.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** `recipeCategory` is a comma-separated list of *personal tags* (§3.3, §12.3) — 128 of the
 *  reference export's 341 recipes carry more than one. Splitting is the importer's job; what
 *  the pipeline receives is already a list. */
function splitCategories(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((tag) => clean(tag))
    .filter((tag): tag is string => tag != null);
}
