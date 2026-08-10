# 2026-08-09 — Paprika 3 recipe library import (+ Buttery-only recipe metadata)

Status: **spec / pre-development**
Tracking issue: [#24 — Support Paprika 3 recipe library imports](https://github.com/dcousineau/buttery/issues/24).
This plan is the living version of that ticket; the issue is a pointer here. Every PR in
this effort should reference `#24` so progress tracks back to it.
Depends on: `02-households-and-private-foundation.md` (household spine, `assertMember`),
`03-household-recipe-collection.md` (the box + rendered `recipe` layer),
`2026-08-02-create-recipes.md` (`extractRecipe`, `saveRecipe`, attribution enforcement,
`recipe_import_attempt`).
Design handoff: [Claude Design project `fbfc377d`](https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2) —
the built screen is [`Paprika Import.dc.html`](https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2?file=Paprika+Import.dc.html)
and the layout exploration it came from is [`Paprika Import Wireframes.dc.html`](https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2?file=Paprika+Import+Wireframes.dc.html).
**The design is the source of truth for layout, copy, and interaction detail — this plan
does not restate it.** §10 records what the design settled, what it changed here, and what
it leaves open; §9.1's four questions are answered there.

> Implementer: log outcomes to `docs/plans/results/2026-08-09-paprika-import-results.md`
> (what was built, how it was verified, deliberate deviations).

---

## 1. Overview

Let a household bulk-import a **Paprika 3 "recipe box" HTML export** by dropping the
exported **folder** into the browser. Paprika writes a directory, not a single file, and
phase 1 takes that directory as-is (§4.2) — no archive step for the user. It is walked and
parsed **entirely client-side**; only dedupe keys (not recipe bodies) cross the wire first;
the user reviews duplicates and resolves attribution; then the accepted recipes are
committed to the household box in chunks.

Two things are being built here, and the plan keeps them apart on purpose. The **importer**
(§4) is Paprika-specific and disposable: it knows what a Paprika export looks like on disk
and how to read one recipe out of it. The **import pipeline** (§5–§9) is generic and is the
part with the long life: dedupe, attribution, review, commit, session bookkeeping,
telemetry. Paprika is the first importer, not the only one this pipeline will ever serve —
read §2.5 before building anything, because it says where the line is and how it is
enforced.

Batch import is **private and local only. It never writes to atproto.** Not as a default,
not behind a checkbox — the commit path has no publish branch at all (§7.4).

This plan also introduces a piece of foundation the app has needed for a while and will
need repeatedly: **first-class Buttery-only recipe metadata** (§5), global and
per-household, that deliberately never appears in an `exchange.recipe.recipe` record.
Paprika import is its first consumer; LLM enhancement of un-editable public records is the
next.

### 1.1 In scope

1. `@buttery/recipe-extract/import` — the importer seam: `RecipeImporter`,
   `ImportCandidate`, `EntrySource`, `directoryEntrySource`. No Paprika in it (§2.5).
2. `@buttery/recipe-extract/paprika` — the one importer phase 1 ships: a Paprika-specific
   parser plus an export walker over an entry source, pure and browser-safe (§4).
3. `recipe_meta` (global) + `household_recipe_meta` (per-household) — namespaced key/value
   sidecar tables, never published (§5).
4. `recipe_import_session` — first-class batch session with status and counts, stamped with
   the importer that produced it (§5.3).
5. Dedupe keys as a real, indexed, backfilled concept: normalized source URL + content
   fingerprint, written on **every** recipe save, not just imports (§6).
6. A read-only `probeImportDuplicates` server function and a `commitImportChunk` server
   function, both sharing the existing single-save core after a refactor (§7).
7. Bulk attribution classification for source strings with no URL (§8).
8. The `/household/recipes/import` route: drop → parse → review → commit → summary (§9).
9. Backfill migration computing dedupe keys for every existing recipe (§6.5).

### 1.2 Out of scope (seams only)

- **Uploading the export's own image bytes.** Phase 1 _commits_ the original remote image
  URL that Paprika preserves, via the existing `storePendingImageFromUrl` path. The review
  screen does **read** the local image bytes to render thumbnails (§10.2, D26) — reading is
  not uploading. Pushing those bytes to blob storage is explicitly deferred (§11), and the
  schema is shaped to accept it later.
- Publishing any imported recipe to atproto — deferred until batch import is trusted (§17).
- Other importers (Paprika `.paprikarecipes` binary format, AnyList, Mela, Recipe Keeper,
  plain JSON-LD folders). Phase 1 ships one importer but builds the seam it plugs into
  (§2.5) and stores which importer ran on the session (§5.3), so the second one is a new
  module rather than a refactor.
- Undo/rollback of a completed import (`recipe_import_session` makes it possible later).
- LLM enhancement — named only as the second consumer of §5.
- Migrating the sidecar to typed columns (§5.5) — deliberately future work.

---

## 2. Principles that constrain this design

### 2.1 Batch import never publishes

Publishing is irreversible, public, and attributed. A 341-recipe batch parsed by a
best-effort scraper is exactly the wrong input for it. `commitImportChunk` writes private
household rows and has no code path to `publishLocalRecipe`. A user who wants an imported
recipe public opens it and publishes it individually through the existing reviewed flow,
which re-runs the public-atproto dedupe check.

### 2.2 Household is the minimum privacy scope

Dedupe never probes another household's private recipes — doing so would leak the
existence of those recipes. The two corpora we check are **this household's box** and the
**public atproto index** (§6.3). `household_recipe_meta` is household-scoped for the same
reason: a Paprika session id and source filename are facts about _this household's_ import,
not about the recipe.

### 2.3 Buttery metadata is never published

`recipe_meta` and `household_recipe_meta` are read by Buttery and by nothing else. Nothing
in `lib/atproto/recipe-writes` or `services/atproto-cron-sync` may read them. This is a
review rule, called out in the migration comment and enforced by a test asserting the
published record shape is unchanged by sidecar rows.

### 2.4 One parser, one save path

`extractRecipe` already exists and the bookmarklet already proved the "browser supplies the
bytes" pattern. Paprika parsing reuses `schemaOrgToLexicon` and the normalizers rather than
growing a parallel mapper, and `commitImportChunk` reuses the same persistence core as
`saveRecipe` (§7.3). Divergence here is how the two paths silently drift apart.

### 2.5 The importer is replaceable; the pipeline is not

Paprika is a **launch point**, not the feature. What the user drops, how it is walked, and
how one recipe is read out of it are facts about Paprika 3 and nothing else (§4). Everything
downstream of "here is a list of parsed candidates with provenance" — dedupe key derivation
(§6), the probe/commit/comparison contracts (§7), attribution classification (§8), the
five-state review flow (§9, §10), the session row, resumability, and telemetry (§5.3, §7.5,
§13) — is generic, and is the part worth building carefully. Adding Mela, AnyList, Recipe
Keeper, or a `.paprikarecipes` binary reader should mean writing an importer and touching
nothing else.

The seam is one interface, exported from a new **`@buttery/recipe-extract/import`** subpath
that contains no Paprika code:

```ts
/** Everything crossing a worker boundary or landing in `jsonb` is JSON, and the type
 *  says so. `Record<string, unknown>` admits functions, `bigint`, and cycles, which
 *  fail `postMessage` structured cloning or `JSON.stringify` *before* the boundary
 *  check in §7.2 can turn them into a clean per-item failure. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** The entire importer-specific surface. Phase 1 ships exactly one implementation. */
export interface RecipeImporter {
  /** Stable, lowercase, no spaces. Stored on the session (§5.3) and in the sidecar (§12.5). */
  readonly id: string;
  /** Product name for UI copy — "Paprika 3". The only place the brand is a string. */
  readonly label: string;
  /** Launch point: turn whatever the browser handed us into an entry source. */
  open(input: ImporterDropInput): Promise<EntrySource>;
  /** Lazily yield one entry per recipe. Drives the "Reading your recipe box…" progress. */
  entries(source: EntrySource): AsyncIterable<ImportEntry>;
  /** Pure, synchronous, worker-safe. */
  parse(entry: ImportEntry): ImportCandidate | ImportParseFailure;
}

/** What every importer produces. The pipeline consumes only this. */
export interface ImportCandidate {
  /** Importer-minted (`crypto.randomUUID()`), stable for the session; joins probe→commit. */
  clientId: string;
  /** Lexicon-shaped, the same type every other extractor produces. */
  recipe: ExtractedRecipe;
  sourceUrl: string | null;
  /** Free text when `sourceUrl` is null — drives the §8 attribution grouping. */
  sourceText: string | null;
  /** → `household_recipe_note` (§12.2). */
  notes: string | null;
  /** Personal tags → keywords (§12.3). Already split by the importer. */
  tags: string[];
  /** Remote image URL — what the commit path stores (§11). */
  imageUrl: string | null;
  /** **Source-relative** path — directly passable to `EntrySource.bytes()` with no
   *  further joining, for review thumbnails only (§4.2, §11). Resolving it is the
   *  importer's job, not the caller's. */
  localImagePath: string | null;
  /** Human-facing provenance; what the failure list shows (§7.2, §10.1). */
  entryName: string;
  /** Opaque to the pipeline. The importer owns the keys; written verbatim to the
   *  sidecar under `ns='import'` (§12.5). Must not use a pipeline-reserved key
   *  (§12.5) — the boundary rejects the item if it does. */
  meta: JsonObject;
}

export interface ImportParseFailure {
  clientId: string;
  entryName: string;
  message: string;
}
```

`EntrySource` (§4.2) and `directoryEntrySource` live here too, not in the Paprika module:
"a bag of lazily-readable relative paths" is what every folder-shaped importer needs, and so
are its guardrails. Root detection and entry filtering stay in the Paprika walker, because
`index.html` and `Recipes/` are Paprika facts.

**`PaprikaParsed` is deleted, not wrapped.** `parsePaprikaRecipe` returns `ImportCandidate`
directly and its named extras — categories, rating, difficulty, photo UID, the verbatim
`raw` strings — become documented `meta` keys (§4.1). A converter between two shapes is a
second place the instruction-splitting logic could go wrong for no gain.

Be honest about what this buys: the split above is real, but where the interface has a
shape at all, **that shape came from Paprika**, and the second importer will find gaps — one
with no per-recipe file has no natural `entryName`, one with multiple images per recipe has
nowhere to put them, one that arrives over OAuth rather than a drop has no `EntrySource` at
all. This interface is expected to move when that happens, and moving it is cheap as long
as one property holds. **What phase 1 owes is that property: no module in the pipeline
imports from `@buttery/recipe-extract/paprika`.** Exactly one module in the web app does —
the importer registry, `services/web/src/lib/recipe-import/importers.ts`, which maps
importer id → `RecipeImporter` and is the sole place the string `paprika` and the launch
screen's importer-specific copy live. Server functions, the parse worker, the review
components, and the route all reach the importer through the registry or consume
`ImportCandidate` and never name it. This is enforced by an ESLint `no-restricted-imports`
block over `services/web/src/server/recipe-import*`,
`services/web/src/lib/recipe-import/**` (registry exempted), and
`services/web/src/components/recipes/import/**`, banning `**/recipe-extract/paprika*` —
not by review, which will not catch it on a Friday (§16).

## 3. Ground truth: what a Paprika 3 export actually contains

Measured against a real 341-recipe export (`~/Documents/My Recipes`, 15 MB). **This section
is fact, not assumption — implementers should not re-derive it, but should re-verify
against their own export if numbers look off.**

### 3.1 Structure

```
My Recipes/
  index.html                       # <ul> of <a href="Recipes/<title>.html">
  Recipes/
    <Recipe Title>.html            # one recipe per file, 341 of them
    Images/
      <UUID[-nnnnn-hex]>/          # 250 dirs, exactly 1:1 with the 250 images
        <UUID>.jpg
```

The folder a user drops may be the export root itself or a parent of it. **Do not assume
`My Recipes/` — locate `index.html` and treat its directory as the root** (§4.2).

### 3.2 The markup is schema.org microdata, not hRecipe

The issue says hRecipe. It is not. Every recipe file is
`<div class="recipe" itemscope itemtype="http://schema.org/Recipe">` with `itemprop=`
attributes. Our `fromMicrodata` walker is the right foundation; `fromHRecipe` is irrelevant
here.

### 3.3 Field-by-field, with the quirks that require a bespoke parser

| `itemprop`                            | Reality                                                                                                                                                             | Handling                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `name`                                | `<h1>`, clean                                                                                                                                                       | direct                                                                                            |
| `recipeIngredient`                    | one `<p class="line">` each; quantity wrapped in `<strong>`                                                                                                         | `.text` per element is already correct (`"1 tablespoon good olive oil"`)                          |
| `recipeInstructions`                  | **one** `<div>` containing N `<p class="line">`                                                                                                                     | **generic parser mashes them into one unpunctuated blob.** Must split on the child `<p>` elements |
| `url`                                 | on the `<a>` wrapping the source; href                                                                                                                              | source URL — **absent on 81/341 (24%)**                                                           |
| `author`                              | the source **domain** (`cooking.nytimes.com`) or free text (`Ottolenghi Simple pg 174`)                                                                             | not an author. Never map to a person; see §8                                                      |
| `comment`                             | Paprika's notes field                                                                                                                                               | → `household_recipe_note` (§12.2)                                                                 |
| `recipeCategory`                      | **comma-separated personal tags**, 43 distinct: `Export to Weeknight dinner, Regular Meals`, `Healthish`, `Marinated Lunch Salads`; 128 recipes carry more than one | split on comma → keywords, not category (§12.3)                                                   |
| `recipeYield`                         | free text: `Serves 6`, `Yield 10 to 12 servings`, `4`                                                                                                               | lexicon `recipeYield` is free text — pass through verbatim                                        |
| `totalTime` / `cookTime` / `prepTime` | **human text, not ISO 8601**: `45 min`, `1 1/2 hours plus cooling time`                                                                                             | `toIsoDuration` handles most; see §3.4                                                            |
| `aggregateRating`                     | `<p itemprop="aggregateRating" class="rating" value="0">` — value in an **attribute**, element text empty                                                           | generic walker drops it (correctly). Personal 0–5 rating; §12.4                                   |
| `difficulty`                          | non-schema.org itemprop, `Easy` / `Medium`                                                                                                                          | §12.4                                                                                             |
| `description`                         | present on a minority                                                                                                                                               | direct → lexicon `text`                                                                           |
| `image`                               | `<img itemprop="image" src="Images/<uuid>/<uuid>.jpg">`, wrapped in `<a href="<original remote URL>">`                                                              | §11 — phase 1 uses the `<a href>`, not the `src`                                                  |
| nutrition                             | markup present in the template; **no recipe in the sample export populates it**                                                                                     | map it anyway (the bridge already does), expect nulls                                             |

### 3.4 Known lossy edges — accept, don't fix

- `toIsoDuration("1 1/2 hours plus cooling time")` yields `PT1H`: the hour regex matches
  `1`, the vulgar fraction and the trailing prose are dropped. **Acceptable** — an
  approximate time beats none, and the raw string is preserved in the sidecar (§12.5).
  Do not build a fraction-aware duration parser for this.
- `index.html` is a convenience listing only. Prefer walking `Recipes/*.html` directly so a
  recipe missing from the index still imports; use `index.html` only to locate the root and
  to sanity-check the count.

### 3.5 There is no usable Paprika recipe UID

Worth stating because it is the obvious thing to reach for and it does not work. The
`Images/<UUID>/` directory names are **photo asset ids** — 250 directories for 250 images,
exactly 1:1, and 91 recipes have no image at all. There is no recipe-level identifier
anywhere in the HTML.

Consequence: **the photo UID is a ~73%-coverage weak key**, useful only for recognizing a
re-import of an unchanged export. It is recorded in `household_recipe_meta`
(`ns='import'`, `key='photo_uid'`, §12.5) and may be consulted as a tie-breaker, but it is
**never a primary dedupe key** (§6.2).

---

## 4. The importer (Paprika-specific): `@buttery/recipe-extract/paprika`

**This section is the only Paprika-shaped part of the feature.** Everything from §5 on is
the pipeline and must work identically for the next importer (§2.5). Two new subpath
exports, reusing the microdata walker, `schemaOrgToLexicon`, and the normalizers.

```
packages/recipe-extract/
  src/
    parse/microdata.ts          (existing, reused)
    import/                     GENERIC — no Paprika anywhere under here
      types.ts                  RecipeImporter, ImportCandidate, ImportEntry, ImportParseFailure
      entry-source.ts           EntrySource + directoryEntrySource(files) + the size/escape guards
      index.ts
    paprika/                    PAPRIKA-ONLY
      recipe.ts                 parsePaprikaRecipe(html, entryName) -> ImportCandidate | ImportParseFailure
      export.ts                 walkPaprikaExport(source) -> AsyncIterable<ImportEntry>
      importer.ts               paprikaImporter: RecipeImporter
      index.ts
  package.json                  exports: ".", "./import", "./paprika"
```

`paprika/` may import from `import/`; nothing under `import/` may import from `paprika/`,
and the ESLint boundary of §2.5 covers this direction too.

**No new dependencies.** Phase 1 reads a dropped directory, so there is no unzip step and
therefore no archive library (D19). `walkPaprikaExport` takes an `EntrySource` rather than
bytes, so an archive-backed source can be added later without touching the parser (§4.2,
§17).

### 4.1 `parsePaprikaRecipe(html, entryName): ImportCandidate | ImportParseFailure`

Pure, synchronous, no network. Returns the pipeline's `ImportCandidate` (§2.5) — there is no
intermediate `PaprikaParsed` type. The lexicon has no home for several Paprika fields; those
go in `meta`, which the pipeline carries opaquely to the sidecar (§12.5). The exact key set
this importer writes:

```ts
// ImportCandidate.meta, as written by the Paprika importer.
{
  /** Split recipeCategory, comma-separated in the export. Also surfaces as `tags`. */
  categories: string[];
  /** 0–5 from the rating element's `value` attribute; null when absent or 0. */
  rating: number | null;
  /** "Easy" / "Medium" / … verbatim. */
  difficulty: string | null;
  /** The photo-asset UUID (§3.5). Weak key, ~73% coverage. */
  photo_uid: string | null;
  /** Verbatim strings for anything lossy or dropped — the unparseable durations especially (§3.4). */
  raw: JsonObject;
}
```

Mapping onto the rest of `ImportCandidate`: `recipe` from the microdata walk; `sourceUrl`
from `itemprop="url"`; `sourceText` from `itemprop="author"`; `notes` from
`itemprop="comment"`, paragraphs joined with `"\n\n"`; `tags` from the comma-split
`recipeCategory`; `imageUrl` from the wrapping `<a href>`; `localImagePath` **resolved**
from the `<img src>` (see note 4 — it is not the raw attribute); `entryName` relative to the
detected export root.

The signature therefore takes the entry's own path, not just its name:
`parsePaprikaRecipe(html, entry: ImportEntry): ImportCandidate | ImportParseFailure`, where
`ImportEntry` carries both `entryName` (root-relative, for humans) and `sourcePath`
(source-relative, for `EntrySource`) — §4.2.

Implementation notes, in the order they matter:

1. **Instructions must be split before the generic walker sees them.** Select the
   `[itemprop="recipeInstructions"]` container, read its child `<p>` elements, and build
   the instruction list from those. Falling through to `elementValue()` produces one
   run-on paragraph and is the single most damaging bug available in this parser.
2. Run the rest through `readItem`/`schemaOrgToLexicon` so keywords, nutrition, diet, and
   yield stay on the shared crosswalk.
3. Read the rating from the element's `value` **attribute** (`getAttribute("value")`), not
   its text. `0` means unrated → `null`.
4. `imageUrl` comes from the **wrapping `<a href>`**. `localImagePath` comes from the
   `<img src>` — **but the raw attribute is not a usable path and must not be stored as
   one.** `src` is `"Images/<uuid>/<uuid>.jpg"`, relative to the _recipe HTML file_ that
   contains it (`Recipes/Foo.html`), while `EntrySource` paths are relative to _whatever
   the user dropped_, which may be a parent of the export root (§3.1). Resolve both hops
   before storing: `localImagePath = normalize(dirname(entry.sourcePath) + "/" + src)`,
   which for a root dropped one level deep yields
   `"My Recipes/Recipes/Images/<uuid>/<uuid>.jpg"`. Storing the bare `src` makes
   `source.bytes(localImagePath)` miss on both axes and every thumbnail render blank.
   Phase 1 commits `imageUrl` and renders `localImagePath` as a local preview only (§11).
5. `sourceText` is a domain when `sourceUrl` is present and free text otherwise — the
   caller must not assume which without checking `sourceUrl`.

### 4.2 `walkPaprikaExport(source): AsyncIterable<ImportEntry>`

Walks an **`EntrySource`** and yields one entry per recipe file. The source type is generic
and lives in `@buttery/recipe-extract/import` (§2.5) — a bag of lazily-readable relative
paths is what any folder- or archive-shaped importer needs. Phase 1 ships exactly one
implementation of it. The walking rules below are Paprika's.

```ts
// Generic — @buttery/recipe-extract/import
export interface EntrySource {
  /** Every entry path, relative to whatever the user handed us, in no guaranteed order. */
  paths(): readonly string[];
  /** Decoded UTF-8 text for one path. */
  text(path: string): Promise<string>;
  /** Raw bytes for one path — used for review thumbnails only (§11). */
  bytes(path: string): Promise<Uint8Array>;
  /** Total byte size across all entries, for the guardrails below. */
  totalBytes(): number;
}

/** A file plus the path it was found at. The path is supplied by the caller, because
 *  only one of the two acquisition paths below puts it on the `File` (see next para). */
export interface DroppedFile {
  path: string;
  file: File;
}

export function directoryEntrySource(files: DroppedFile[]): EntrySource;

/** One recipe's worth of bytes, handed to `RecipeImporter.parse`. */
export interface ImportEntry {
  /** Root-relative, human-facing: `"Beef Bourguignon 2.html"`. Goes in the sidecar. */
  entryName: string;
  /** Source-relative, machine-facing: what `EntrySource` was keyed by. Sibling assets
   *  (images) resolve against this, never against `entryName` (§4.1 note 4). */
  sourcePath: string;
  html: string;
}
```

**Why `DroppedFile` and not `File[]`:** the two acquisition paths do not agree on where the
path lives. `<input type="file" webkitdirectory>` populates `File.webkitRelativePath`;
directory **drag** traversal does not — `FileSystemFileEntry.file()` hands back a `File`
whose `webkitRelativePath` is `""`, and the only path that exists is the one the traversal
accumulated (or `FileSystemEntry.fullPath`). Reducing both inputs to `File[]` silently
discards every drag path, which is the primary interaction the design draws. The route
adapts both to `{ path, file }`: `webkitRelativePath` for the picker, the accumulated
traversal path for the drop. **`File` handles are lazy** — nothing is read off disk until
`text()` or `bytes()` asks, so a 15 MB export costs nothing until parsing starts.

- **Root detection:** find the entry whose basename is `index.html` at the shallowest
  depth; its directory is the root. Fall back to "the shallowest directory containing a
  `Recipes/` folder". Never hardcode `My Recipes/`. This matters as much for a directory as
  it did for an archive — the user may drop the parent (§3.1).
- Yields `ImportEntry` for every `Recipes/*.html`, skipping `index.html`, anything under
  `Images/`, and `__MACOSX/` / `.DS_Store` noise. `entryName` is always relative to the
  detected root; `sourcePath` is always the key the `EntrySource` actually holds. The two
  differ by exactly the detected root prefix, and conflating them is the bug in §4.1 note 4.
- Yields lazily so the UI can show real progress across a few hundred files.
- **Image bytes are read in phase 1, for previews only.** `source.bytes(localImagePath)` +
  `URL.createObjectURL` renders the review thumbnails (§10.2, D26). The review pane does
  this through the `EntrySource` it already holds and the candidate's `localImagePath` —
  no joining, no root prefixing, no Paprika knowledge; the importer already resolved the
  path (§4.1 note 4). Reading is not uploading: the commit path still writes
  `imageUrl` and nothing local reaches blob storage (§11). Revoke the object URLs when the
  review screen unmounts.
- **Guardrails belong to the generic entry source, not to Paprika:** reject an export over
  200 MB total, over 5 000 entries, or any entry whose normalized path escapes the root.
  They are properties of "a pile of files a user handed us", so `directoryEntrySource`
  enforces them and every future source inherits them. Path-escape rejection is cheap
  insurance that survives a future archive-backed source, where it stops being theoretical.
  Root detection is the Paprika half and stays in the walker.

### 4.3 Tests

Fixture-driven, checked into `packages/recipe-extract/src/paprika/__fixtures__/`. Copy
**four real recipe files** from the sample export (do not synthesize them — the quirks are
the point):

| Fixture                           | Covers                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `beef-bourguignon.html`           | URL source, image, notes, single category, `recipeYield` prose, multi-paragraph instructions |
| `air-fryer-chicken-parmesan.html` | `totalTime`, URL with tracking params (§6.1), multi-word category                            |
| `arroz-con-pollo.html`            | **no URL**, free-text source, no image, numeric yield                                        |
| `apple-bourbon-bundt-cake.html`   | `cookTime` with the unparseable `1 1/2 hours plus cooling time`                              |

Assertions that must exist: instructions split into ≥4 separate steps (not one blob);
`sourceUrl === null` with a non-null `sourceText` on the no-URL fixture; `tags` splits on
comma; `imageUrl` is the remote `https://` URL; **`localImagePath` is source-relative and
round-trips** — feed the parser an entry at `Outer/My Recipes/Recipes/Foo.html` and assert
the returned `localImagePath` is a key the stub source actually holds, not the bare
`Images/<uuid>/<uuid>.jpg` from the attribute; `meta.rating` reads from the attribute.

Plus an in-memory `EntrySource` stub (a `Map<path, string | Uint8Array>` — no filesystem, no
`File`) exercising root detection when the root is nested one and two levels deep, the entry
filters (`index.html`, `Images/`, `__MACOSX/`, `.DS_Store`), path-escape rejection, and both
size caps. The stub lives under `src/import/` beside the interface, not under `paprika/`, so
the second importer's tests can use it. `directoryEntrySource` itself gets one thin test
that `DroppedFile.path` maps onto `paths()`; everything else tests against the stub.

---

## 5. Buttery-only recipe metadata (pipeline)

The foundation piece, and entirely generic: these tables know about recipes, households, and
imports, and never about Paprika. Two tables, namespaced key/value with a `jsonb` value.

### 5.1 `recipe_meta` — global, about the recipe itself

```
recipe_meta
  recipe_id   text    not null  references recipe(id) on delete cascade
  ns          text    not null            -- "dedupe", "llm.enhance", …
  key         text    not null
  value       jsonb   not null
  updated_at  timestamptz not null default now()
  primary key (recipe_id, ns, key)
```

```
index recipe_meta_lookup on recipe_meta (ns, key)
index recipe_meta_dedupe on recipe_meta ((value #>> '{}')) where ns = 'dedupe'
```

**The generic index deliberately does not include `value`.** A B-tree index entry is capped
at ~2704 bytes (a third of an 8 kB page), while §7.2 permits an 8 kB serialized metadata
value — so indexing `value` generically makes an in-spec write fail with `index row size
… exceeds btree maximum` at insert time, for no reason other than that the row is indexed.
Lookups by value are only ever needed for the dedupe keys, which are short, bounded strings,
so those get their own narrow expression index and everything else gets a
`(ns, key)`-prefixed scan. Any future namespace that needs a value lookup adds its own
partial index and takes responsibility for its own size bound.

Facts true of the recipe regardless of who holds it. Phase 1 writes exactly two:
`('dedupe','source_url_key')` and `('dedupe','content_fp')` (§6).

### 5.2 `household_recipe_meta` — per household+recipe

```
household_recipe_meta
  household_id  text  not null  references household(id) on delete cascade
  recipe_id     text  not null  references recipe(id) on delete cascade
  ns            text  not null
  key           text  not null
  value         jsonb not null
  updated_at    timestamptz not null default now()
  primary key (household_id, recipe_id, ns, key)
```

```
index household_recipe_meta_lookup on household_recipe_meta (household_id, ns, key)
index household_recipe_meta_session
  on household_recipe_meta ((value #>> '{}'))
  where ns = 'import' and key = 'session_id'
```

Same reasoning as §5.1, and it bites harder here: this is where the importer's `raw` blob
lands, so it is exactly the table whose values approach the 8 kB cap. The one value lookup
the pipeline actually performs — "every recipe from session X", for the counters (§7.7) and
the future undo pass (§17) — gets its own bounded partial index.

**All import bookkeeping lives here** — it is a fact about this household's import, not
about the recipe (§2.2).

**One namespace for every importer: `ns='import'`, with the importer named in a key, not in
the namespace.** The alternative — `ns='import.paprika'`, `ns='import.mela'` — was
considered and rejected. It makes "everything I ever pulled in from Paprika" a single
indexed prefix scan and gives each importer a private key space, but it makes "where did
this recipe come from" and "everything I ever imported, from any app" an N-namespace union
that grows every time an importer ships, and it forces the generic pipeline to build a
namespace string out of the importer's id in order to write rows it otherwise handles
opaquely. The app-agnostic question is the one the product actually asks — an import
history, an undo-a-session pass (§17), a provenance line on a recipe — so it gets the cheap
query and the per-app question pays a `key='importer'` filter.

The cost, stated plainly: importers share a key space, so `rating` means whatever the last
importer to touch this (household, recipe) pair meant by it. That is tolerable because these
rows describe **how this recipe arrived in this box**, of which there is one true answer at
a time; a second import of the same recipe is dedupe-skipped and writes nothing, and a
deliberate re-import (§6.3, D23) overwriting the older provenance is the right outcome. The
`importer` key says which app's vocabulary the rest of the namespace is speaking. §12.5 is
the full key list.

### 5.3 `recipe_import_session`

```
recipe_import_session
  id              text  primary key            -- ulid()
  household_id    text  not null references household(id)
  did             text  not null
  importer        text  not null               -- RecipeImporter.id, e.g. 'paprika' (§2.5)
  status          text  not null               -- see below
  file_name       text                         -- what the user handed us, e.g. "My Recipes"
  total_count     integer not null default 0
  imported_count  integer not null default 0
  skipped_count   integer not null default 0
  failed_count    integer not null default 0
  started_at      timestamptz not null default now()
  finished_at     timestamptz
```

```
index recipe_import_session_household on recipe_import_session (household_id, started_at desc)
```

`status`: `parsing` → `reviewing` → `committing` → `complete`, plus terminal `failed` and
`abandoned`. A session left in `committing` is what makes resume-after-disconnect possible
(§7.5). No cleanup job in phase 1; stale sessions are harmless rows.

**The column is `importer`, and it holds `RecipeImporter.id` (§2.5) — nothing else.** Naming
it `source` was the first instinct and is a trap: `recipe_import_attempt.source` already
exists in `services/web/src/server/recipe-scrape.ts` and means something different — the
_transport_ a single scraped recipe arrived over, `'scrape'` or `'bookmarklet'`. Those two
value spaces must never be confused or merged: an importer id answers "which app's export is
this", a transport answers "how did these bytes reach us". `'scrape'` and `'bookmarklet'` are
not legal values here and never will be. The table is unshipped, so renaming costs nothing
now and a mistaken join costs later.

Legal values are exactly the ids in the importer registry (§2.5) — phase 1: `'paprika'`. The
column is free text, following the sibling table's precedent, so a new importer needs no
migration; validation lives at the boundary instead. The server function that opens a
session validates the submitted id against a Zod enum **derived from the registry**, so
adding an importer adds a value in one place and an unknown id is a 400, not a row. **No
column default** — a default silently mislabels the second importer's sessions the first
time someone forgets to pass one.

### 5.4 Access helpers

`services/web/src/server/recipe-meta.ts`, server-only, thin:

```ts
getRecipeMeta(db, recipeId, ns): Promise<JsonObject>
setRecipeMeta(db, recipeId, ns, entries): Promise<void>          // upsert
getHouseholdRecipeMeta(db, householdId, recipeId, ns): Promise<JsonObject>
setHouseholdRecipeMeta(db, householdId, recipeId, ns, entries): Promise<void>
```

Batch variants (`setManyHouseholdRecipeMeta`) matter — the commit path writes ~6 keys ×
25 recipes per chunk and should do it in one statement.

### 5.5 Explicitly future: typed columns

Key/value + `jsonb` is chosen for velocity, not permanence. It has real costs — no type
safety, `value = to_jsonb($1::text)` at every call site, no FK on values. The expectation
is that features which prove durable graduate to typed columns or a purpose-built table.
Record that intent in the migration comment so the next person doesn't mistake it for an
endorsement.

---

## 6. Dedupe (pipeline)

Generic. Dedupe operates on `ImportCandidate` and on recipes already in the box; no rule
here knows where a candidate came from. The percentages are from the reference Paprika
export because that is the corpus we measured, not because the logic is Paprika-shaped.

### 6.1 `source_url_key` — normalized URL, the primary signal

Deterministic, pure, lives in `packages/recipe-schemas/src/normalize/url.ts` so client and
server compute it identically. **The client computes it for the probe; the server
recomputes it before writing and never trusts the client's value.**

```
normalizeSourceUrl(raw) -> string | null
  1. parse; non-http(s) -> null
  2. host: lowercase, strip leading "www.", drop default port
  3. drop the fragment entirely
  4. drop GLOBAL tracking params (exact names, case-insensitive) -- these carry no
     resource identity anywhere:
       utm_*  fbclid  gclid  dclid  msclkid  mc_cid  mc_eid  _ga  igshid  si
       ref  ref_src  ref_source
  5. drop HOST-SCOPED params, only on the hosts that mint them:
       nytimes.com, cooking.nytimes.com -> action  module  region  pgType  rank  source
     (match on the normalized host or any subdomain of it)
  6. sort surviving params by name, then value
  7. path: percent-decode UNRESERVED characters only (ALPHA / DIGIT / "-" / "." / "_" /
     "~"); leave every reserved delimiter encoded -- %2F, %3F, %23, %26, %3D stay as
     written. Then collapse "//", strip trailing "/" unless path is "/"
  8. return "<host><path>[?<params>]"   -- no scheme; http/https are the same recipe
```

Two deliberate narrowings, both to stop the **primary** dedupe key producing a hard skip:

- **`source`, `action`, `module`, `region`, `rank` are host-scoped, not global.** They are
  exactly the junk NYT Cooking appends and are present verbatim in the sample export — but
  they are ordinary semantic query parameters elsewhere (`?action=print`,
  `?source=archive`), and stripping them everywhere collapses genuinely distinct URLs onto
  one key. A false positive here silently skips a recipe the user wanted; a false negative
  merely shows them a duplicate they can dismiss. Prefer the false negative. `pgType` is
  NYT-only in practice too and is scoped with the rest.
- **Percent-decoding is unreserved-only.** Decoding the whole path makes `/a%2Fb` and `/a/b`
  the same key, and they are not the same resource. Unreserved decoding still gets the
  normalization that matters (`%2D` → `-`, `%7E` → `~`) with no collapse risk.

Stored at `recipe_meta (ns='dedupe', key='source_url_key')`. Null source URL → no row.

### 6.2 `content_fp` — content fingerprint, for the 24% with no URL

```
normalizeLine(s):
  NFKC normalize; lowercase; strip diacritics
  collapse whitespace; trim
  drop leading/trailing punctuation (keep interior digits, letters, "/" for fractions)

content_fp = "sha256:" + sha256(
    normalizeLine(name) + "\n" +
    normalizeLine(each ingredient).sort().join("\n")
)
```

Design choices worth defending:

- **Ingredients sorted** so reordering doesn't change the fingerprint.
- **Instructions excluded** — formatting and step-splitting vary far more than ingredient
  text, and including them makes the fingerprint near-useless across sources.
- **Name included** so two unrelated recipes with a coincidentally identical ingredient set
  don't collide.

Stored at `recipe_meta (ns='dedupe', key='content_fp')`. Computed with WebCrypto
(`crypto.subtle.digest`) on the client and `node:crypto` on the server — same input string,
same digest.

### 6.3 What we check against

| Corpus                                                                                  | Verdict         | Default action                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| This household's box (`household_recipe` join `recipe`) — URL key or fingerprint match  | `in_box`        | **Skip by default**, overridable per row (see below).                                                                       |
| Public atproto index (`recipe.visibility='public' and uri is not null`) — URL key match | `public_exists` | **Offer the link.** Add the existing public recipe to the box. Per-recipe choice, plus an apply-to-all. Link-or-skip (D22). |
| Normalized-title match only, no key match                                               | `maybe`         | **Import, flagged.** Soft warning in review; never auto-skip.                                                               |
| Nothing matches                                                                         | `new`           | Import.                                                                                                                     |
| Two export entries resolving to the same key                                            | `dupe_in_batch` | Collapse client-side before the probe; report the count.                                                                    |

Other households' private recipes are never consulted (§2.2).

Two refinements the design settled (§10.2):

- **`public_exists` is link-or-skip, not link-or-private-copy** (D22). Declining the link
  means the recipe is not imported at all. A deliberate private duplicate of a public record
  the user just found is a bad third option and nobody asked for it.
- **`in_box` is overridable** (D23). The review screen lets a user tick a known duplicate to
  bring in a second copy anyway; that item carries `override: "duplicate"` on commit (§7.2).
  This is the one case where §7.5's convergence guarantee does not hold, and §15 says so.

`public_exists` accepted → `addRecipeToHousehold({ recipeId })`, the existing server
function, and a `household_recipe_meta` row recording that this slot in the import resolved
to an existing record.

### 6.4 Fuzzy title matching

There is **no `normalized_title` column**, and this plan does not add one. The `recipe` table
has `name` plus a gin trigram index on that raw column
(`services/web/src/db/migrations/1785300000000_create_recipe_rendered.ts:90-94`), so the
probe matches against what exists:

```sql
similarity(r.name, $1) > 0.85
```

where `$1` is the candidate's **raw** name, not `normalizedTitle`. Scoped to the household,
capped at a handful of candidates per probe, and served by the existing
`recipe_name_trgm_idx` with no new index and no new column to keep in sync across the local
write path _and_ the cron-sync render path (§6.6) — which a stored normalized column would
require, and which is exactly the kind of second writer that goes stale.

`ProbeInput.items[].normalizedTitle` is therefore replaced by `title` (§7.1): the server
compares raw names, `pg_trgm` absorbs the case and punctuation differences that
normalization was there to handle, and a client-computed value that no index can match is
not sent at all. The `maybe` verdict is advisory and never auto-skips (§6.3), so trigram
similarity on the raw name is precise enough for what it drives.

**`pg_trgm` is a hard prerequisite, not a risk to hedge.** The earlier fallback-to-exact-
equality paragraph was wrong: migration `1785300000000_create_recipe_rendered.ts:41` already
runs `create extension if not exists pg_trgm` and line 90 builds a trigram index on it, so a
Postgres without the extension fails that migration and never reaches this feature's
migration at all. There is no database that runs this code and lacks `pg_trgm`. Nothing to
decide at migration time, nothing to record in the results doc.

### 6.5 Backfill migration — do not skip this

Existing recipes have no `recipe_meta` rows, so without a backfill the household-box check
matches nothing and the first import happily duplicates the entire existing box.

The migration must, for every existing `recipe`:

1. Compute `source_url_key` from `recipe_attribution.url` where `kind='website'`.
2. Compute `content_fp` from `recipe.name` + its `recipe_ingredient` rows.
3. Insert both into `recipe_meta`.

The fingerprint is easiest to get exactly right in TypeScript (it must be byte-identical to
the runtime one). Do it in the migration's `up` with the shared `normalize` functions
rather than reimplementing the hash in SQL — a divergent backfill is worse than none.

### 6.6 Dedupe keys are written by **every** writer, not just imports

There are three writers into `recipe`, and all three must maintain the keys. Missing any one
of them does not degrade dedupe gracefully — it makes a whole corpus invisible to it.

1. **`persistRecipeDraft` (§7.3)** writes both keys for every recipe it creates.
2. **The recipe edit path** updates them when name or ingredients change.
3. **The cron-sync render path** — `renderRecipe` in
   `services/atproto-cron-sync/src/render.ts:385-471` — upserts `recipe` and rewrites
   `recipe_ingredient` and `recipe_attribution` wholesale, entirely outside
   `persistRecipeDraft`. It must compute and upsert both `recipe_meta` dedupe rows in the
   same transaction, from the same projected values it just wrote.

**Writer 3 is load-bearing and easy to miss.** The §6.5 backfill covers public records that
exist _the day it runs_; every record synced or re-rendered afterwards would arrive with no
keys at all, so the `public_exists` check (§6.3) would quietly stop firing for anything
published after ship — the failure mode is a silent absence of matches, not an error.
Re-render also invalidates: the upsert replaces `name` and every ingredient row, so keys
written earlier describe content that is gone. And `DELETE_RENDERED_SQL`
(`render.ts:346`) deletes sync rows whose record turned invalid, which cascades the
`recipe_meta` rows away — correct, and it means re-render is the only thing that puts them
back.

The cron service is Node-native TypeScript with the import rules that implies: pull
`normalizeSourceUrl` and the fingerprint helper from `packages/recipe-schemas` through an
explicit `.js` subpath, and use `node:crypto` for the digest. Same input string, same digest
as the web path (§6.2) — assert it in a test that runs both.

---

## 7. Server contracts (pipeline)

Generic, and the most important place for that to be true: **no server module in this
section imports from `@buttery/recipe-extract/paprika`** (§2.5, §16). Every input below is
derived from `ImportCandidate`, and the importer's own vocabulary travels as an opaque
`meta` bag the server writes to the sidecar without inspecting.

### 7.1 `probeImportDuplicates` — read-only

```ts
// POST. Keys only — no recipe bodies, no ingredient text.
interface ProbeInput {
  sessionId: string;
  items: Array<{
    clientId: string; // client-minted, stable for this session
    sourceUrlKey: string | null;
    contentFp: string;
    /** Raw candidate name. Compared with `similarity(recipe.name, $1)` against the
     *  existing trigram index — there is no normalized-title column (§6.4). */
    title: string;
  }>;
}

/** Identity of a matched recipe. The review screen renders all four fields (§10.2, D20). */
interface ExistingRef {
  recipeId: string;
  name: string;
  addedAt: string; // ISO; household_recipe.created_at, or the public record's indexedAt
  addedByHandle: string | null; // DIDs resolved in ONE batched query, not per item
}

type ProbeVerdict =
  | { clientId: string; verdict: "new" }
  | { clientId: string; verdict: "in_box"; existing: ExistingRef }
  | { clientId: string; verdict: "public_exists"; existing: ExistingRef }
  | { clientId: string; verdict: "maybe"; candidates: ExistingRef[] };
```

Read-only, no writes beyond advancing the session to `reviewing`. Reveals only recipes the
caller's household can already see, or public records — no new information leaks. Sized for
one call per ~200 items; the client chunks if larger.

**Still keys-only.** `ExistingRef` carries identity, not content. The review screen's
side-by-side diff needs bodies, and those come from a separate lazy call (§7.6) made only
for the recipes the user actually opens — not from fattening this response.

### 7.2 `commitImportChunk`

**Items are a discriminated union on `action`.** The result type has always had a `linked`
status, but an import-shaped item carries no way to say _which_ record to link, and §6.3
requires linking the exact record the user reviewed — so the shape below is the only one
that can express what the review screen already lets the user decide. A bare
import-shaped item is ambiguous between "create this privately" and "add that existing
public record", and the server must not guess.

```ts
interface CommitChunkInput {
  sessionId: string;
  items: CommitItem[];
}

interface CommitItemBase {
  clientId: string;
  entryName: string;
}

type CommitItem =
  | (CommitItemBase & {
      action: "import";
      record: RecipeRecordInput; // lexicon-shaped, minus server-owned fields; MAY be user-edited (§10.2, D25)
      sourceUrl: string | null;
      attribution: AttributionInput | null; // resolved in review (§8)
      imageSourceUrl: string | null; // remote URL (§11)
      notes: string | null;
      tags: string[];
      override?: "duplicate"; // user deliberately re-imported an `in_box` match (§6.3, D23)
      /** ImportCandidate.meta, verbatim. The server writes it to the sidecar (§12.5)
       *  and never reads a key out of it. Adding an importer adds no field here. */
      meta: JsonObject;
    })
  | (CommitItemBase & {
      action: "link";
      /** The `ExistingRef.recipeId` the probe returned for this item's `public_exists`
       *  verdict and the user accepted (§6.3, D22). */
      existingRecipeId: string;
      notes: string | null;
      meta: JsonObject;
    })
  | (CommitItemBase & { action: "skip" });

type CommitItemResult =
  | { clientId: string; status: "imported"; recipeId: string }
  | { clientId: string; status: "linked"; recipeId: string } // public_exists accepted
  | { clientId: string; status: "skipped"; reason: "duplicate" | "user" }
  | { clientId: string; status: "failed"; message: string };
```

`action: "link"` calls the existing `addRecipeToHousehold({ recipeId })` and writes the
sidecar rows, nothing else — no `persistRecipeDraft`, no new `recipe` row. **The server
revalidates `existingRecipeId` rather than trusting it:** the row must exist, be
`visibility='public'` with a non-null `uri`, and not already be in this household. Anything
else fails that item. A client-supplied id that reaches `addRecipeToHousehold` unchecked is
an arbitrary-row-into-my-box primitive, and it is reachable by anyone who can call the
endpoint — the probe having returned the id earlier is not a check the server can rely on,
because the server does not remember what it returned.

`action: "skip"` writes nothing and returns `skipped: "user"`. It exists so the client can
report a complete accounting of the session (§7.7) without the server having to infer
absence — an excluded recipe is a decision the user made, not a gap.

Chunk size **25**. Each item is wrapped independently: a validation failure or a bad row
fails that item only and the chunk returns partial results. Client drives the loop and
renders progress. **The chunk does not increment session counters** — see §7.7.

`CommitItemResult` deliberately does **not** carry the entry name. The client holds the
`clientId → entryName` map from the parse and joins locally to render the "didn't make it"
list (§10.1). Do not add a server field for it.

`meta` being opaque does not make it unbounded or unvalidated. It is client-supplied
`jsonb`, so the boundary enforces three things, failing the **item** and never the chunk:

- **Size** — 8 KB serialized per item, generous next to the Paprika `raw` blob's well under
  1 KB.
- **Shape** — parses as `JsonObject` (§2.5). No functions, no `bigint`, no cycles.
- **Reserved keys** — `importer`, `session_id`, `entry_name`, and `source_text` are
  pipeline-owned (§12.5) and are **rejected**, not merged and not silently overwritten. All
  five namespaced rows are upserted into the same `ns='import'` key space, so an importer
  that emitted one of these would clobber the provenance the pipeline is required to write.
  Paprika does not, and a reserved-key list is cheaper than finding out when the second
  importer does.

Opaque to the pipeline's _logic_, still validated at the _boundary_.

### 7.3 Required refactor of `recipes-write.ts`

`runSave` currently interleaves attribution resolution, lexicon validation, dedupe, insert,
image handling, and publish in one function. Extract the reusable middle so both callers
share it — **this is the point of the refactor, not a cleanup nicety**:

```
persistRecipeDraft(db, ctx, {
  record, attribution, sourceUrl, imageSourceUrl, visibility
}): Promise<{ status: "ok"; recipeId } | { status: "invalid"; issues }>
    - assemble + $safeValidate           (existing logic, unchanged)
    - ulid() + insertLocalRecipe         (existing, unchanged)
    - compute + write dedupe keys        (NEW, §6.6)
    - pending image from URL             (existing storePendingImageFromUrl)
    - NO dedupe check, NO publish        -- both are the caller's business
```

Then:

- `saveRecipe` = attribution resolution → public-atproto dedupe (when publishing) →
  `persistRecipeDraft` → optional publish. **Behavior unchanged; this must be true and
  the existing tests must prove it.**
- `commitImportChunk` = per-item attribution (§8) → **recompute keys → household dedupe
  check** (below) → `persistRecipeDraft` → notes, keywords, and sidecar rows. No publish
  branch exists, and no counter increments (§7.7).

`resolveAttribution` gains an explicit free-text/publication path (§8) rather than being
duplicated.

**Dedupe keys are recomputed from the submitted record, never taken from the client.** §6.1
already said this for `source_url_key`; it is now equally load-bearing for `content_fp`,
because the review screen lets the user edit a recipe's name and ingredients _after_ the
probe ran (§10.2, D25). `persistRecipeDraft` derives both keys from `record` at write time,
so the stored fingerprint always describes what was actually saved.

**An edited recipe is not re-probed, so `commitImportChunk` re-checks.** The verdict shown in
review is the verdict for the recipe as parsed; a user can edit one into an exact match of
something already in the box and the review screen will not notice. Closing that gap is the
commit path's job, and it needs an explicit check — `persistRecipeDraft` is defined above to
perform **no** dedupe, and `recipe_meta`'s primary key is `(recipe_id, ns, key)`, so writing
a key that already exists on a _different_ recipe raises no conflict and nothing "notices" on
its own. Per item, before `persistRecipeDraft`:

```
1. recompute source_url_key + content_fp from the SUBMITTED record
2. look for a recipe in this household carrying either key
     (household_recipe join recipe join recipe_meta, ns='dedupe')
3. found, and no `override: "duplicate"`  -> return skipped:"duplicate", write nothing
   found, with the override                -> import anyway (§6.3, D23)
   not found                               -> persistRecipeDraft
```

Step 2 is the same query the probe already runs for the `in_box` verdict, against one item
instead of 200 — reuse it rather than writing a second one that can drift. The check runs
for **every** item, not just edited ones: it is also what makes a retried chunk converge
(§7.5) and what makes the earlier probe advisory rather than load-bearing.

A duplicate found here is the correct outcome, not an error: the summary reports it and the
chunk must not fail. Do not add a re-probe on every keystroke to close the gap at the other
end.

### 7.4 Publishing is structurally impossible here

`commitImportChunk` does not import `publishLocalRecipe`, does not read
`isAtprotoPublishEnabled`, and always inserts with `visibility='private'` and
`uri = null`. Add a test asserting that a full import produces zero rows with a non-null
`uri` and that `publishLocalRecipe` is never called.

### 7.5 Resumability

The session row plus per-item `clientId`s make a dropped connection recoverable: on
re-entry, the client re-probes and the server reports already-imported items as `in_box`,
so a retry converges rather than duplicating. The server-side check in §7.3 is what makes
that guarantee hold even when the probe is skipped, stale, or replayed — convergence does
not depend on the client asking first. Full resume-from-session UI is out of scope;
**convergence on retry is not** — a user who refreshes mid-import and re-runs it must not
end up with 200 duplicates.

Two limits on that guarantee, both deliberate:

- An item the user force-imported with `override: "duplicate"` (§6.3) will import again on a
  re-run. That is the user's explicit instruction, twice.
- **Everything the user did in review is lost on refresh.** Parse output, verdicts,
  attribution decisions, per-recipe edits, and include/exclude choices are all in-memory
  (§9); nothing is persisted and phase 1 adds no persistence. What survives a refresh is
  the recipes already committed — which is exactly what makes the re-run converge. The
  design's commit-screen copy ("closing it stops the import where it stands; nothing already
  saved is lost, and running it again picks up only what's missing") is the whole contract,
  and the UI must not imply more.

### 7.6 `getImportComparison` — read-only, lazy

The review screen's duplicate queue and compare overlay render the **existing** recipe
beside the incoming one, line by line (§10.2, D21). That needs bodies, which §7.1 refuses to
carry. Separate call, made only when the user opens a comparison:

```ts
interface ComparisonInput {
  sessionId: string;
  recipeIds: string[]; // ≤ 25 per call
}

type ComparisonResult = Record<
  string, // recipeId
  {
    name: string;
    recipeYield: string | null;
    hasImage: boolean;
    ingredients: string[];
    instructions: string[];
    addedAt: string;
    addedByHandle: string | null;
  }
>;
```

- `assertMember`-scoped, and subject to §2.2 exactly as the probe is: it returns only
  recipes this household can already see, or public records. An id the caller cannot see
  is simply absent from the result — never a 403 that confirms the row exists.
- Fetched for what the user opens, not for every match. In the reference export that is
  roughly 55 recipes out of 341, versus 341 bodies if this were folded into the probe.
- **The diff itself is computed client-side.** Both sides are in the browser by then. There
  is no server-side diff, no match score, and no per-line similarity field — do not add one.

### 7.7 `finalizeImportSession` — counters and completion

The client drives the commit loop, so nothing on the server knows a chunk was the last one.
Without an explicit end there is no moment at which `status='complete'` and `finished_at`
can be set, and §13's exactly-once `recipe_import_completed` event has no emitter. An
`isLast` flag on the final chunk is the wrong shape — the last chunk is exactly the one most
likely to be lost to the network, and items the user excluded may mean there is no final
chunk at all.

```ts
interface FinalizeInput {
  sessionId: string;
  /** What the client actually observed across every chunk. Reconciled, not trusted — see
   *  below. Sent so the summary screen and the event agree with each other. */
  outcome: {
    total: number;
    imported: number;
    linked: number;
    skippedDuplicate: number;
    skippedUser: number;
    failed: number;
    overriddenDuplicate: number;
    editedBeforeCommit: number;
    parseFailures: number;
    distinctSourceStringsClassified: number;
  };
}
```

**Counters are derived, never incremented.** `imported_count`, `skipped_count`, and
`failed_count` on `recipe_import_session` (§5.3) are computed at finalize from
`household_recipe_meta` rows carrying this `session_id` — which is what
`household_recipe_meta_session` (§5.2) indexes. Per-chunk `count = count + n` is not
idempotent: a chunk whose response is lost is retried, dedupe correctly refuses to create a
second recipe, and the counters gain a phantom skip and keep the original import. Deriving
them makes a retried chunk a no-op by construction, with no per-item ledger table and no
`(session_id, client_id)` idempotency record to maintain. Counts the sidecar cannot answer —
user-skipped, parse failures, edited-before-commit — come from the client's `outcome`, and
are reporting figures rather than facts about rows.

**Finalize is idempotent.** Called on an already-`complete` session it recomputes, returns
the same numbers, and emits nothing. That is what makes it safe for the client to retry, and
it is why the telemetry event fires here and nowhere else.

Sessions that are never finalized — the user closed the tab — stay in `committing` forever
and are harmless (§5.3): the recipes are saved, the next run converges, and no cleanup job
exists in phase 1.

---

## 8. Attribution for candidates with no source URL (pipeline)

Generic. This step's whole input is `ImportCandidate.sourceText` for every candidate whose
`sourceUrl` is null; it never asks which app produced them. Every recipe-manager export has
this shape — a free-text "where this came from" field that is not a lexicon attribution —
so this is the pipeline step most likely to pay off on the second importer unchanged.

`saveRecipe` rejects a record with no lexicon-valid attribution, and in the reference export
81/341 recipes have no source URL. Their source strings are cookbooks, and there are only
**28 distinct values** across those 81 recipes — including six spellings of one Gordon
Ramsay title (`Godon`, `Godron`, `ROmsay's`, `Appettie`, `Heathly`).

### 8.1 Bulk classification step

The review screen groups the URL-less recipes by their exact source string and asks the
user to classify each distinct string **once**, applying to every recipe using it:

| Choice                 | Produces                                   | Note                                                                     |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Cookbook / publication | `attributionPublication { title, author }` | both required by the lexicon; the UI collects author, prefilling nothing |
| Person                 | `attributionPerson { name }`               |                                                                          |
| Website                | `attributionWebsite { name, url }`         | for cases like `Tiktok` where the user wants to supply a URL             |
| Skip these             | item marked `skipped:user`                 | not imported                                                             |

Because the typo variants are separate strings, the user can map all six Ramsay spellings
to the same publication and the misspellings never reach the record.

The design took both affordances this plan had left optional, and both are **pure
client-side string work in the parse worker** — neither needs a server call (§10.2):

- **Page-reference split.** Strip a trailing `\s+(pg|pgs?|p\.?)\s*\d+` from the source
  string to prefill the publication title, so `Ottolenghi Simple pg 174` prefills
  `Ottolenghi Simple`. The page reference is not lost: `source_text` keeps the whole string
  verbatim in the sidecar (§8.2, §12.5), which is exactly what the UI's "page reference will
  be kept on the recipes" promises.
- **Misspelling hint.** A pairwise similarity pass over the ≤28 distinct strings, surfacing
  "looks like a misspelling of one above" so the six Ramsay variants cluster visibly.
  Normalized Levenshtein ≥ 0.8 (or a trigram ratio) is fine; 28² comparisons is nothing.
  It is a **hint only** — it never merges strings or answers on the user's behalf.

### 8.2 Non-negotiables

- **Never auto-invent attribution.** Writing a cookbook title into the `author` field, or a
  page reference into a person's `name`, produces wrong data that publishes later if the
  user ever makes the recipe public. This was considered and rejected.
- The raw source string is **always** preserved verbatim in the sidecar
  (`ns='import'`, `key='source_text'`) regardless of what the user chose.
- Three recipes in the sample have neither a URL nor a source string. They cannot be
  auto-attributed. Surface them as a **29th group** — an "no source at all" card carrying
  the same four classification controls as every other group — and gate the import on it
  like the rest. The design draws this card with copy but no controls; that is an
  oversight, not a decision (§10.3). A card the user cannot act on is a dead end in a flow
  whose primary button stays disabled until every group is answered.
- Recipes **with** a URL are unaffected — server-built `attributionWebsite`, exactly as the
  existing import path does today.

---

## 9. Client flow (pipeline, with one importer-specific screen)

Route `/household/recipes/import`, reached from the existing `AddRecipeChooser`.
**§10 and the design files own layout and copy.** This is the state machine and the
technical constraints they have to live inside.

```
  drop                 IMPORTER-SPECIFIC: the launch point. What to drop, the copy that
                       explains it, and turning it into an EntrySource all come from the
                       RecipeImporter the registry resolved (§2.5). Everything below is not.
    → parse        importer.entries() + importer.parse(), in a Web Worker → ImportCandidate[]
    → keys         normalizeSourceUrl + content_fp per candidate; collapse in-batch dupes
    → probe        POST keys only → verdicts
    → review       attribution classification, duplicates, per-recipe include/exclude/edit
    → commit       chunks of 25, progress from real per-item results, then one
                   finalizeImportSession call that closes the session (§7.7)
    → summary      imported / linked / skipped / failed, with the failures listed
```

The `drop` state is where a second importer plugs in: it renders `importer.label` and the
importer's own drop copy, and calls `importer.open()`. Phase 1 resolves the importer to
`'paprika'` on entry rather than offering a choice — the chooser is a second-importer
problem, and building it now would be UI nobody asked for (§10). Everything from `parse` on
is written against `ImportCandidate` and must not name an importer.

Technical constraints on the UI:

- **Parse in a Web Worker.** 341 files through `node-html-parser` on the main thread will
  visibly jank. `RecipeImporter.parse` is required to be pure and worker-safe for exactly
  this reason (§2.5); the Paprika implementation is, by construction. The worker takes an
  importer **id** and resolves it through the registry — it does not import a parser
  directly, or the boundary of §2.5 leaks through a worker entrypoint.
- Everything up to `commit` is in-memory and discardable; a refresh loses only work, never
  data. That now includes per-recipe edits (§7.5) — no drafts, no autosave, no local
  storage in phase 1.
- 341 rows needs virtualization or pagination; grouping by verdict (`new` / `in_box` /
  `public_exists` / `maybe`) is what makes it reviewable at all. The design supplies the
  grouping but not the windowing (§10.3).
- Failed items are listed by **`ImportCandidate.entryName`** (§2.5) so the user can find them
  in the app they exported from; the client joins `clientId → entryName` locally (§7.2).
- Bulk actions are needed at this scale: select-all-new, skip-all-duplicates,
  link-all-public. The design satisfies all three with per-group Select all / Skip all
  plus group defaults (§10.1) — three separately named buttons are not required.

### 9.1 UX questions for the design agent — **answered, see §10.1**

Kept for the record; the design settled all four.

1. Is attribution classification (§8) a distinct step before review, or a section within it?
2. Do `maybe` matches sit inline with a warning badge, or in their own group?
3. What does a partially-failed import offer — retry the failures, or just report them?
4. Is a completed import's summary reachable later (the session row supports it), or
   transient?

---

## 10. Design handoff

The design workshop happened after this plan's first draft. **The design files are the
source of truth for layout, copy, spacing, and interaction detail — this section does not
restate them.** Read them before building anything in §9.

The comp draws one Paprika-specific screen — the drop state, whose copy is built on what
Paprika writes — and four generic ones. Build the four against `ImportCandidate`, not
against the export (§2.5). The only Paprika strings that survive into the shipped UI are the
ones the registry hands over as `label` and drop copy.

- Project — <https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2>
- Final comp — [`Paprika Import.dc.html`](https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2?file=Paprika+Import.dc.html)
- Wireframes / flow exploration — [`Paprika Import Wireframes.dc.html`](https://claude.ai/design/p/fbfc377d-df73-49b5-8611-a35de8c690c2?file=Paprika+Import+Wireframes.dc.html)

The comp uses the vendored design system and almost only primitives that already exist in
`services/web/src/components/ui` — Alert (including `AlertAction`), Badge, Button, Card,
Checkbox, Input, Textarea, Sidebar\*, all at sizes those components already ship.

**One new primitive is required: a progress bar.** The comp uses one in three places
(reading, committing, and the duplicate queue) and hand-rolls it as a bare `div` with a
percentage width. Build it once, with `role="progressbar"` semantics from the start (§10.4).

Two things the comp hand-rolls must instead use what already exists:

- The **compare overlay** is a bare fixed `div`. It must be `dialog.tsx` — which also
  supplies the focus trap, Esc, and focus restore the comp is missing.
- The **four attribution chips** are bare `button`s with a colour-only pressed state. They
  are semantically a four-way choice and must be built on `radio-group.tsx`.

### 10.1 What the design settled

Answers to §9.1, in order. **Attribution is a section inside review, not a separate step** —
it is the first group in the review rail and it gates commit, with the primary button
reading "Sort the sources first" until every distinct source string is answered.
**`maybe` matches get their own group and their own shape** — a one-at-a-time, line-by-line
diff queue rather than an inline badge, though they also carry a "maybe a dupe" badge
wherever they surface in other lists. **A partially-failed import only reports** — failures
are listed by export entry name with no retry affordance. **The summary is transient**, and
says so out loud: "This summary isn't saved anywhere — copy the list before you leave."

The rest of what it settled: five states (`drop → reading → review → committing → done`)
plus a compare overlay; a three-pane review whose left rail holds five groups worked top to
bottom (Need a source · Maybe duplicates · Already yours · Already public · Ready to
import); parse, key derivation, and probe presented as a single "Reading your recipe box…"
bar rather than three; master–detail list plus preview pane for the three verdict groups,
with the preview offering "Edit this recipe" and "Compare"; a done screen of four stat tiles
over a failure list; and copy that states the privacy and no-publish guarantees outright on
the drop, reading, and done screens rather than burying them.

§9's three required bulk actions are satisfied structurally rather than by name: "Select
all" / "Skip all" scoped to the group in view, with "Already yours" defaulting to nothing
selected and "Already public" defaulting to everything selected, gives select-all-new,
skip-all-duplicates, and link-all-public without three separate buttons. Do not add them.

### 10.2 What the design changed about this plan

- **D19 — the drop target takes the folder Paprika writes, and only that** (§4.2). Paprika 3
  emits a directory, and the comp's copy is built on that fact ("Paprika writes a folder, not
  a single file"). Phase 1 drops the archive path entirely: no unzip dependency, no bundle
  assertion. That copy is importer-owned and lives with the Paprika importer, not in the
  route; `walkPaprikaExport` takes a generic `EntrySource` so an archive-backed source stays
  a later addition rather than a rewrite (§17).
- **D20 — probe verdicts carry the matched recipe's identity, not just its id** (§7.1). The
  preview alert and the compare header render its name, when it was added, and who added it,
  so every verdict returns `ExistingRef`, with DIDs resolved in one batched query.
- **D21 — a new lazy `getImportComparison`** (§7.6). The duplicate queue and compare overlay
  render the existing recipe's full ingredients, steps, yield, and photo presence. The probe
  stays keys-only; bodies are fetched for what the user opens (~55 of 341). The diff is
  computed client-side once both sides are local.
- **D22 — `public_exists` is link-or-skip, not link-or-private-copy** (§6.3).
- **D23 — an `in_box` duplicate is overridable per row** (§6.3). "Tick one to bring in a
  second copy"; `CommitChunkInput.items` gains `override?: "duplicate"`, and it is the only
  hole in §7.5's convergence guarantee.
- **D24 — the summary separates user-skipped from duplicate-skipped** (§13). The comp's four
  tiles cover imported / linked / already-yours / failed; a user who skips 40 recipes
  deliberately needs to see where they went, not discover it later in the box.
- **D25 — full per-recipe editing before commit** (§7.3). Editable name, one Input per
  ingredient, one Textarea per step, exactly as drawn. Reuse `IngredientsEditor`,
  `InstructionsEditor`, and `LineEditor` from `services/web/src/components/recipes/create/`
  rather than growing a second set. Three consequences are spelled out in §7.3 and §7.5:
  dedupe keys are recomputed server-side from the submitted record, an edited recipe is not
  re-probed and lands as `skipped: "duplicate"` if the edit created one, and every edit is
  in-memory and dies with a refresh.
- **D26 — review thumbnails read local bytes; the commit path still writes the remote URL**
  (§11). Amends §4.2's original "phase 1 does not read image bytes". Reading is not
  uploading; the blob-storage work stays deferred.
- Two affordances §8.1 had left optional are now specified, and both are pure client-side
  string work in the parse worker: the `pg 174` title/page split that prefills a publication
  title, and the "looks like a misspelling of one above" hint that clusters the six Ramsay
  variants. Neither needs a server call, and neither may answer on the user's behalf.

### 10.3 What the design leaves open

- **Virtualization.** The largest group is still 293 rows in a single scroller and the comp
  draws no windowing. §9's requirement stands — virtualize or paginate. Nothing suitable is
  in `services/web/package.json` today, so this is a dependency decision as much as a
  component one. Record what shipped in the results doc.
- **Error states.** No screen is drawn for a failed parse, a failed probe, a failed
  comparison, or a mid-commit network failure, though §13 logs all of them. The "Keep this
  tab open" alert is the only failure-adjacent copy in the comp. Build the rest.
- **The "No source at all" card has copy but no controls**, which §8.2 requires. Treat it as
  a 29th group with the same four controls; this is an oversight in the comp, not a decision.
- **The rail's counts do not sum to the recipe total**, because "Need a source" is
  cross-cutting — an unattributed recipe is also in "ready to import". The comp never says
  so. The shipped rail should.
- **Phone layout.** The three-pane review is drawn at 1440×900 only.

### 10.4 Accessibility floor (binding)

`role="progressbar"` with `aria-valuenow` and `aria-valuetext` on all three bars, and a
**throttled** `aria-live="polite"` region for the "{n} of 341 read" / "{n} of 305 saved"
labels — announce at chunk boundaries, not on every tick, or the flow becomes unusable with
a screen reader running.

The compare overlay is a real dialog: focus trap, Esc, focus restored to the control that
opened it.

Difference is **never encoded by fill colour alone**. Every changed or absent line in the
diff and compare views carries a text or glyph marker in addition to the butter fill, and
the same applies to the selected row in the review list and the danger state on the "Need a
source" group.

Rail groups and list rows are real buttons with `aria-current`, keyboard-openable, with
Space toggling a row's checkbox without opening the row.

Attribution chips are a labelled radio group named by the source string, and their revealed
fields get real labels — "Book title" and "Author — required" are placeholders in the comp,
and placeholders are not labels. The required author field is marked `required` with its
constraint in `aria-describedby`, and a disabled primary button always has a reachable
reason.

Focus moves to the new region's heading on every state transition — `drop → reading →
review → committing → done` swaps the entire main region five times — and on editor
open/close, with focus restored to "Edit this recipe" on the way back.

---

## 11. Images — phase 1 is remote-URL only

**Decision: commit the original remote URL; preview the local bytes; upload neither.**

Paprika preserves the source image URL in the `<a href>` wrapping each `<img>`, so phase 1
passes it as `imageSourceUrl` and reuses `storePendingImageFromUrl` — the exact path the
existing single-recipe import already uses, SSRF-guarded and size-capped. No new upload
endpoint, no multi-megabyte client uploads.

Known cost, accepted: images whose source is dead, paywalled, or hotlink-blocked are lost
**at commit time**, and 91 recipes have no image at all.

**Review thumbnails are a separate question, and they read locally** (§10.2, D26). The
export's ~11 MB of image bytes sit on the user's disk behind lazy `File` handles, so the
review screen resolves `localImagePath` through `source.bytes()` + `URL.createObjectURL` and
shows the real photo — including for recipes whose remote URL is already dead, which is
precisely when the user is deciding whether to keep them. The alternative, hotlinking 293
third-party URLs from the user's browser during review, is slower, leaks a referer to 293
domains, and renders broken tiles at the worst moment.

**Reading is not uploading.** No local byte ever reaches the server in phase 1: object URLs
are created in the browser, revoked on unmount, and the commit path sends `imageSourceUrl`
and nothing else. Phase 2 (§17) is the part that uploads — it prefers the export's blob and
falls back to the remote URL, strictly additive, and the seam is already in place and is
generic (`ImportCandidate.localImagePath` plus `EntrySource.bytes()`, §2.5), so phase 2
lands for every importer at once rather than per-importer.

**Rate limiting:** `storePendingImageFromUrl` performs a server-side fetch per recipe.
250 of those in a burst is a self-inflicted outbound traffic spike. Either bound
concurrency inside the commit path or make image fetching a deferred pass. Decide during
implementation and record it — do not let a chunk of 25 fire 25 uncapped outbound fetches.

---

## 12. Field mapping summary

The left-hand side of §12.1–§12.4 is the Paprika export; the right-hand side is what the
pipeline does with an `ImportCandidate`, and it does the same thing regardless of which
importer filled one in.

### 12.1 Into the lexicon record

`name`, `text` (from `description`), `ingredients`, `instructions` (split, §4.1),
`recipeYield` (verbatim prose), `prepTime`/`cookTime`/`totalTime` (via `toIsoDuration`,
lossy per §3.4), `nutrition` (via the bridge; empty in practice), `keywords` (§12.3).

### 12.2 Notes → `household_recipe_note`

`ImportCandidate.notes` — for Paprika, the `itemprop="comment"` paragraphs joined with
`\n\n` — authored by the importing user's DID. The table is keyed
`(household_id, recipe_id)`, and the candidate carries at most one notes blob, so this is a
clean 1:1. Empty notes write no row. An importer with multiple note objects per recipe joins
them itself; the pipeline takes one string.

### 12.3 Tags → keywords, not category

`ImportCandidate.tags` is personal tags (§3.3), not a controlled vocabulary — Paprika's
comma-split `recipeCategory`, and whatever the equivalent is elsewhere. Splitting is the
importer's job; what follows is the pipeline's, for each value:

1. Try `slugForLabel('category', value)`. The **first** match sets `recipe.recipe_category`
   (a single column). In practice almost nothing will match, which is correct.
2. **Every** value — matched or not — becomes a `recipe_keyword` row.
3. The importer's raw list also reaches the sidecar via `meta` (§12.5).

### 12.4 Rating and difficulty → dropped from the record, kept in the sidecar

Neither has a lexicon field, and inventing one is out of scope. They are **not lost**: both
ride in `ImportCandidate.meta` and land in `household_recipe_meta` under `ns='import'`,
which is the right scope for them anyway (a rating is a household's opinion, not a property
of the recipe). A future household-rating feature can read them straight out. The pipeline
never reads either key; it writes what the importer put in `meta`.

### 12.5 Sidecar rows written per imported recipe

`household_recipe_meta`, `ns='import'` (§5.2 — one namespace for every importer). The
pipeline writes these four itself, for every import from every importer:

| key           | value                                                         |
| ------------- | ------------------------------------------------------------- |
| `importer`    | `RecipeImporter.id`, e.g. `"paprika"` (§2.5, §5.3)            |
| `session_id`  | the `recipe_import_session.id`                                |
| `entry_name`  | `ImportCandidate.entryName`, e.g. `"Beef Bourguignon 2.html"` |
| `source_text` | the candidate's verbatim source string (§8.2)                 |

**Those four key names are reserved.** They live in the same `ns='import'` key space as the
importer's own keys, so `commitImportChunk` rejects an item whose `meta` contains any of them
rather than letting the upsert overwrite pipeline-owned provenance (§7.2). The list is a
constant beside the writer, not a comment.

Then one row per key of `ImportCandidate.meta`, written verbatim and never inspected. What
the Paprika importer puts there (§4.1):

| key          | value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `photo_uid`  | photo-asset UUID or null (§3.5)                                       |
| `rating`     | 0–5 or null                                                           |
| `difficulty` | `"Easy"` / `"Medium"` / null                                          |
| `categories` | the raw comma-split array                                             |
| `raw`        | every verbatim string, including the unparseable duration text (§3.4) |

A second importer's keys land beside these, in the same namespace, and `importer` says whose
vocabulary they are.

`recipe_meta`, `ns='dedupe'`: `source_url_key`, `content_fp`.

### 12.6 Deviation from the original answer: no `recipe_import_attempt` rows

The initial intent was to preserve the raw parse on `recipe_import_attempt.parsed`. That
table's `url` column is `NOT NULL` and **24% of Paprika recipes have no URL**, so a batch
would need 341 rows with fabricated URLs. Since `household_recipe_meta` (§5.2) did not
exist when that call was made and is a strictly better home — household-scoped, queryable,
attached to the recipe rather than to a scrape attempt — the raw parse goes there instead
and batch import writes no `recipe_import_attempt` rows at all. The session table covers
the audit need. **Flagged explicitly because it contradicts an earlier decision.**

---

## 13. Telemetry (pipeline)

PostHog, server-side, one event per session (not per recipe — 341 events per import is
noise), emitted from `finalizeImportSession` (§7.7) and nowhere else — that is the only call
that knows the import ended, and its idempotency is what makes "one event per session" true
rather than aspirational. **The event names are importer-agnostic and carry `importer` as a
property** —
`recipe_import_completed`, not `paprika_import_completed`. A per-app event name means every
funnel, insight, and alert has to be rebuilt when the second importer ships, and comparing
importers becomes a union instead of a breakdown. Every event below carries
`importer: "paprika"`.

- `recipe_import_completed`: total, imported, linked, skipped-duplicate, skipped-user,
  overridden-duplicate (§6.3), edited-before-commit count, failed,
  distinct-source-strings-classified, duration, parse-failure count.
- `recipe_import_failed`: where it died (`parse` / `probe` / `comparison` / `commit`) and
  the message.

`skipped-duplicate` and `skipped-user` stay separate all the way to the summary screen —
they are different facts about different user intent, and collapsing them hides recipes the
user chose to drop (§10.2, D24).

No recipe names, URLs, or ingredient text in properties.

---

## 14. Testing

**Unit** (`packages/recipe-extract`)

- The four real fixtures, per §4.3, with the instruction-splitting assertion as the
  headline test.
- `walkPaprikaExport` against the in-memory entry-source stub: root detection at two nesting
  depths, entry filtering, path-escape rejection, both size caps.
- **`localImagePath` is a real key**: with the export root nested one level deep, the path
  `parsePaprikaRecipe` returns is present in `source.paths()` and `source.bytes()` resolves
  it. Assert against the stub's key set, not against a string literal — the bug this catches
  (§4.1 note 4) produces a plausible-looking path that simply is not there.
- `directoryEntrySource`: `DroppedFile.path` maps onto `paths()`, for both a picker-shaped
  input (path from `webkitRelativePath`) and a drag-shaped one (path from the traversal, with
  `webkitRelativePath === ""` on the `File`) — the second is the regression test for §4.2.
- The page-reference split and the misspelling hint (§8.1), including all six Ramsay
  variants clustering and the hint never mutating a string.
- `normalizeSourceUrl`: the NYT tracking-param case verbatim from the export, http/https
  equivalence, `www.` stripping, param sorting, trailing slash. Plus the two narrowings of
  §6.1 — `?action=print` **survives** on a non-NYT host and is stripped on
  `cooking.nytimes.com`; `/a%2Fb` and `/a/b` produce different keys.
- `content_fp`: stable under ingredient reordering and whitespace/case changes; different
  under a name change; **identical between the WebCrypto and node:crypto paths**.

**DB** (`services/web/src/server`)

- `probeImportDuplicates` returns each of the four verdicts against seeded data, with
  `ExistingRef.name` / `addedAt` / `addedByHandle` populated and DIDs resolved in one query.
- A household cannot probe, compare, or commit into another household (`assertMember`).
- The probe never returns another household's private recipe, including on an exact
  fingerprint match.
- `getImportComparison` (§7.6) omits ids the caller cannot see rather than throwing, and
  returns bodies for the ones it can.
- An item committed with `override: "duplicate"` imports despite an `in_box` match; without
  it, the same item is skipped.
- A record edited after the probe is fingerprinted from the **submitted** record, and an
  edit that turns a recipe into an existing duplicate comes back `skipped: "duplicate"`
  without failing the chunk (§7.3).
- `commitImportChunk` partial failure: a bad item fails alone, the rest import, and the
  counters derived at finalize match what was actually written.
- An `action: "link"` item adds the reviewed public record to the box and creates no new
  `recipe` row; an `existingRecipeId` that is private, non-existent, or belongs to another
  household fails **that item** and adds nothing.
- **Chunk replay is a no-op**: committing the identical chunk twice produces the same
  recipes and the same finalized counters as committing it once (§7.7 derived counters).
- `finalizeImportSession` is idempotent — called twice, the session reads `complete` with
  identical counts and exactly one `recipe_import_completed` event is emitted.
- A session whose commit loop is abandoned mid-way stays `committing` and leaves its already
  imported recipes intact.
- Re-running an identical import produces zero new recipes (§7.5 convergence).
- **The cron-sync render path writes dedupe keys** (§6.6): rendering a synced record
  populates both `recipe_meta` rows; re-rendering it with changed content replaces them; the
  values are byte-identical to the web path's for the same input.
- **No published record**: after a full import, zero rows have a non-null `uri`; the
  publish path is never invoked (§7.4).
- The backfill migration produces fingerprints byte-identical to the runtime function.
- Sidecar rows do not change the published record shape (§2.3).
- A session opened with an importer id that is not in the registry is rejected (§5.3).
- `commitImportChunk` round-trips an item whose `meta` holds keys it has never heard of; an
  oversized `meta` fails that item alone; and a `meta` carrying a reserved key
  (`importer` / `session_id` / `entry_name` / `source_text`) fails that item rather than
  overwriting the pipeline's own sidecar row (§7.2, §12.5).
- A metadata value at the 8 KB cap **inserts successfully** — the regression test for the
  index shape of §5.1/§5.2, which fails with `index row size … exceeds btree maximum` if
  anyone puts `value` back into the generic B-tree.

**Boundary** (lint, not runtime)

- `pnpm lint` fails if any module under the pipeline's directories imports
  `@buttery/recipe-extract/paprika` (§2.5, §16). Prove the rule works by adding the import,
  watching it fail, and removing it — a boundary rule nobody has ever seen fire is a
  boundary rule that does not exist.

**Manual**

- The real 341-recipe export end-to-end, twice — the second run must report 341 duplicates
  and import nothing.

---

## 15. Decisions

| #   | Decision                                                                    | Why                                                                     |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D1  | schema.org microdata parser, not hRecipe                                    | The export is microdata; the issue was wrong (§3.2)                     |
| D2  | Bespoke Paprika parser over generic `fromMicrodata`                         | Instruction splitting, attribute-valued rating, dual image paths (§3.3) |
| D3  | `/import` and `/paprika` subpaths, not new packages                         | Reuses the bridge and normalizers; no new dependency at all (§4)        |
| D4  | Namespaced key/value + `jsonb` sidecar                                      | Velocity now; typed columns are the acknowledged future (§5.5)          |
| D5  | Paprika bookkeeping is household-scoped                                     | It's a fact about this household's import, not the recipe (§2.2)        |
| D6  | Normalized URL primary, content fingerprint secondary, fuzzy title advisory | URL alone leaves 24% unchecked (§6)                                     |
| D7  | No cross-household private dedupe                                           | Leaks existence of private recipes (§2.2)                               |
| D8  | Photo UID is never a primary key                                            | It's a photo-asset id at 73% coverage, not a recipe id (§3.5)           |
| D9  | Bulk-classify the 28 distinct source strings                                | 28 decisions instead of 81; never invents attribution (§8)              |
| D10 | Read-only probe before commit                                               | Accurate review before any write; keys-only payload (§7.1)              |
| D11 | Chunks of 25 with per-item results                                          | Real progress, isolated failures, convergent retry (§7.2)               |
| D12 | Batch import cannot publish, structurally                                   | Irreversible + public + best-effort parse (§2.1)                        |
| D13 | Remote image URLs in phase 1                                                | Reuses an existing guarded path; export bytes deferred (§11)            |
| D14 | Categories → keywords, not the category vocab                               | They're personal tags (§12.3)                                           |
| D15 | Rating/difficulty in the sidecar, not the record                            | No lexicon field; household scope is right anyway (§12.4)               |
| D16 | No `recipe_import_attempt` rows for batch                                   | `url` is NOT NULL; contradicts an earlier call, see §12.6               |
| D17 | Dedupe keys written on every save                                           | Otherwise the corpus is stale immediately (§6.6)                        |
| D18 | Backfill migration is mandatory                                             | Without it the first import duplicates the whole box (§6.5)             |

Design-driven, from §10:

| #   | Decision                                                               | Why                                                                         |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| D19 | Drop the **folder**, not a zip; no archive dependency                  | Paprika writes a directory; the entry source is the seam (§4.2)             |
| D20 | Probe verdicts carry `ExistingRef`, not a bare id                      | Review renders the match's name, date, and adder (§7.1)                     |
| D21 | A lazy `getImportComparison`; the probe stays keys-only                | Diffs need bodies for ~55 recipes, not all 341 (§7.6)                       |
| D22 | `public_exists` is link-or-skip                                        | A private copy of a record you just found is a bad option (§6.3)            |
| D23 | `in_box` is overridable per row, via `override: "duplicate"`           | Explicit user intent; the one exception to convergence (§6.3, §7.5)         |
| D24 | The summary separates user-skipped from duplicate-skipped              | Otherwise 40 deliberately skipped recipes vanish silently (§13)             |
| D25 | Full per-recipe editing before commit                                  | Reuses the existing create-flow editors; keys recomputed server-side (§7.3) |
| D26 | Review thumbnails read local bytes; commit still writes the remote URL | Real photos during review, no upload, no 293 hotlinks (§11)                 |
| D27 | Attribution is the first review group and gates commit                 | 81 recipes cannot be saved unattributed; make that unmissable (§10.1)       |
| D28 | `maybe` gets its own one-at-a-time diff queue                          | 9 judgement calls deserve a decision surface, not a badge (§10.1)           |
| D29 | The summary is transient; failures are reported, not retryable         | Session rows make both revisitable later; neither is phase 1 (§17)          |

Boundary decisions, from §2.5:

| #   | Decision                                                                           | Why                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| D30 | One `RecipeImporter` / `ImportCandidate` seam; the pipeline never imports Paprika  | The importer is disposable, the pipeline is not; enforced by lint, not by review (§2.5, §16)   |
| D31 | The session column is `importer`, holding a registry-validated `RecipeImporter.id` | `recipe_import_attempt.source` already means _transport_; the two spaces must not merge (§5.3) |
| D32 | One shared sidecar namespace `ns='import'`, with `importer` as a key inside it     | "Everything I ever imported" is one query; per-app is one filter (§5.2, §12.5)                 |

Review-driven, from the PR on this plan:

| #   | Decision                                                                   | Why                                                                                                 |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| D33 | Commit items are a union on `action: import \| link \| skip`               | `linked` was a result with no input that could ask for it; the id is revalidated server-side (§7.2) |
| D34 | `commitImportChunk` re-checks household dedupe before writing              | `persistRecipeDraft` does no dedupe and duplicate keys raise no conflict — nothing "noticed" (§7.3) |
| D35 | Session counters are derived at `finalizeImportSession`, never incremented | Per-chunk increments are not idempotent; deriving beats an item ledger (§7.7)                       |
| D36 | An explicit finalize call, not an `isLast` chunk flag                      | The last chunk may be lost or may not exist; completion and telemetry need one owner (§7.7)         |
| D37 | Sidecar indexes drop `value`; dedupe gets a narrow expression index        | B-tree caps an entry at ~2704 B while §7.2 permits 8 KB values (§5.1, §5.2)                         |
| D38 | `source`/`action`/`module`/`region`/`rank` are host-scoped to NYT          | They are semantic parameters elsewhere; over-stripping hard-skips valid recipes (§6.1)              |
| D39 | Fuzzy match runs on raw `recipe.name`; no normalized-title column          | The column never existed, and a second stored field means a second writer to keep in sync (§6.4)    |
| D40 | The entry source takes `{ path, file }`, not `File[]`                      | Drag traversal leaves `webkitRelativePath` empty; `File[]` silently loses every drag path (§4.2)    |
| D41 | The importer resolves `localImagePath` to a source-relative key            | `<img src>` is relative to the recipe file, and source paths may be root-prefixed (§4.1)            |
| D42 | Four sidecar keys are reserved against `ImportCandidate.meta`              | Shared key space; an importer could otherwise clobber pipeline provenance (§7.2, §12.5)             |
| D43 | `pg_trgm` is a prerequisite, not a fallback                                | An earlier migration already creates it; a database without it never reaches this feature (§6.4)    |

---

## 16. Acceptance criteria

1. A Paprika 3 export **folder** dropped on `/household/recipes/import` parses fully
   client-side, with no recipe body sent to the server before the review step, and no
   archive step asked of the user.
2. All 341 recipes in the reference export parse without error; instructions arrive as
   separate steps, never one run-on paragraph.
3. Recipes already in the household's box are detected by normalized URL **or** content
   fingerprint and skipped by default.
4. A recipe whose source URL an existing public atproto record cites offers the existing
   record instead of creating a private copy; accepting adds that exact record to the box
   via an `action: "link"` item whose id the server revalidates as public (§7.2).
5. Two export entries that resolve to the same key collapse before the probe.
6. Possible duplicates by title are flagged, never auto-skipped.
7. All 81 URL-less recipes are attributable through at most **29** classification decisions
   — the 28 distinct source strings plus the "no source at all" group covering the three
   recipes with neither a URL nor a source string (§8.2) — and no attribution is
   auto-invented.
8. Every recipe with a URL gets server-built `attributionWebsite`; the raw source string is
   preserved in the sidecar in every case.
9. **No imported recipe is published to atproto.** Every row is `visibility='private'` with
   `uri = null`, and the publish path is not invoked.
10. Paprika notes appear as a household note; categories appear as keywords; rating,
    difficulty, and the full raw parse are readable from `household_recipe_meta`.
11. A commit chunk with one bad recipe imports the other 24 and reports the failure by
    export entry name.
12. Re-importing the same export after a **completed** import imports nothing and reports
    341 duplicates. The only ways a re-run creates a row are a recipe that was never
    committed the first time — skipped by the user, excluded, failed, or left uncommitted
    when the tab closed, all of which are still genuinely new — and an item the user
    explicitly overrides (§6.3), which imports a second copy of something already in the
    box. No recipe already imported or linked is ever created twice without an override.
13. Refreshing mid-import and re-running converges — no duplicate recipes — and a chunk
    replayed after a lost response changes neither the recipes nor the final counters (§7.7).
14. `saveRecipe`'s existing behavior is unchanged by the refactor; its tests pass untouched.
15. Every existing recipe has `source_url_key` (where applicable) and `content_fp` after
    the backfill migration, byte-identical to the runtime computation.
16. The review list stays usable at 341 rows — windowed or paginated, never 293 live rows
    — and is fully keyboard-operable end to end: every group, row, chip, and dialog is
    reachable and actuable without a pointer (§10.4).
17. A member of another household cannot probe, compare, or commit into this household.
18. Review thumbnails render from local bytes, and a full import uploads zero image bytes —
    every stored image arrived through `storePendingImageFromUrl` (§11).
19. **No module under `services/web/src/server/recipe-import*`,
    `services/web/src/components/recipes/import/**`, or `services/web/src/lib/recipe-import/**`
    imports from `@buttery/recipe-extract/paprika`** — the sole exception is the registry,
    `lib/recipe-import/importers.ts`. Enforced by an ESLint `no-restricted-imports` block
    over those paths (§2.5), so `pnpm lint` fails on a violation; the rule is committed with
    a test that it actually fires (§14). The same rule bans `paprika` imports from
    `packages/recipe-extract/src/import/**`. Directory convention and review are the backup,
    not the mechanism.
20. A completed import ends with `finalizeImportSession`: the session reads `complete` with
    `finished_at` set, its counters match the rows the session actually produced, and exactly
    one `recipe_import_completed` event is emitted no matter how many times the client calls
    it (§7.7).
21. Every recipe rendered by `services/atproto-cron-sync` carries both dedupe keys, and
    re-rendering a changed record replaces them rather than leaving stale ones (§6.6).
22. A **fixture importer** — a dozen lines returning one hand-written `ImportCandidate` over
    a `Map`-backed `EntrySource` — can be registered and driven through parse → probe →
    commit in a test without editing a single pipeline module. This is the cheapest honest
    proof that D30 holds; it lives in tests and ships nothing.
23. Results logged to `docs/plans/results/2026-08-09-paprika-import-results.md`.

---

## 17. Deferred / next

**The payoff is the second importer.** Everything in §5–§13 was built once so that Mela,
AnyList, Recipe Keeper, a `.paprikarecipes` binary reader, or a plain-CSV importer is a new
module under `packages/recipe-extract/src/<app>/` plus one line in the registry — a parser, a
walker, a `label`, an id — and nothing else. Dedupe, attribution, review, commit, sessions,
and telemetry are already theirs. If the second importer turns out to need a pipeline change,
that is the interface moving as §2.5 predicted; make the change in the seam and keep the
`no-restricted-imports` boundary rather than letting a second app's vocabulary leak
downstream. The plan's estimate is that `ImportCandidate` grows a field or two and nothing
else has to move.

- **Uploading the export's image bytes** (§11) — the client already reads them for review
  thumbnails; phase 2 uploads them to blob storage and falls back to the remote URL.
  Strictly additive, and generic: `ImportCandidate.localImagePath` and `EntrySource.bytes()`
  are already in the seam, so it lands for every importer at once.
- **An archive-backed entry source.** Phase 1 ships `directoryEntrySource` only, but
  `EntrySource` is a generic interface (§4.2) precisely so a `.paprikarecipes` binary
  importer — or a plain zip, if users ask for one — is a new source implementation rather
  than a parser change. **Keep the abstraction; do not inline directory traversal into the
  walker** for the sake of a few lines.
- **An importer chooser on the drop screen.** Phase 1 hard-resolves `'paprika'` because
  there is one importer and a picker with one option is worse than no picker (§9). The
  second importer makes this a real screen; the registry already supplies `label` and drop
  copy for it.
- **Retrying failed items** in place, instead of listing them for the user to re-export.
- **A revisitable import summary.** `recipe_import_session` already stores the counts; the
  design deliberately made the summary transient (D29), and un-deferring it is a UI change
  plus one read, not a schema change.
- **Publishing imported recipes** — once batch import is trusted, a reviewed
  "publish selected" pass over already-imported private recipes.
- **Undo an import session** — the session id is on every imported recipe, so
  "remove everything from this session" is a query away.
- **LLM enhancement** — the second consumer of `recipe_meta` (§5): derived summaries and
  normalized fields for public atproto recipes we cannot edit.
- **Typed-column migration** for durable sidecar namespaces (§5.5).
- **Other importers** — `.paprikarecipes` binary, Mela, AnyList, Recipe Keeper. The
  `RecipeImporter` seam (§2.5) and `recipe_import_session.importer` (§5.3) are what make
  each one a module rather than a project.
- **Household ratings** — a real home for the Paprika ratings sitting in the sidecar.
- **Duration parsing for vulgar fractions** — only if it turns out to matter.
