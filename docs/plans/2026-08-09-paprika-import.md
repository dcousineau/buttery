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

Batch import is **private and local only. It never writes to atproto.** Not as a default,
not behind a checkbox — the commit path has no publish branch at all (§7.4).

This plan also introduces a piece of foundation the app has needed for a while and will
need repeatedly: **first-class Buttery-only recipe metadata** (§5), global and
per-household, that deliberately never appears in an `exchange.recipe.recipe` record.
Paprika import is its first consumer; LLM enhancement of un-editable public records is the
next.

### 1.1 In scope

1. `@buttery/recipe-extract/paprika` — a Paprika-specific parser plus an export walker over
   a pluggable entry source, pure and browser-safe (§4).
2. `recipe_meta` (global) + `household_recipe_meta` (per-household) — namespaced key/value
   sidecar tables, never published (§5).
3. `recipe_import_session` — first-class batch session with status and counts (§5.3).
4. Dedupe keys as a real, indexed, backfilled concept: normalized source URL + content
   fingerprint, written on **every** recipe save, not just imports (§6).
5. A read-only `probeImportDuplicates` server function and a `commitImportChunk` server
   function, both sharing the existing single-save core after a refactor (§7).
6. Bulk attribution classification for source strings with no URL (§8).
7. The `/household/recipes/import` route: drop → parse → review → commit → summary (§9).
8. Backfill migration computing dedupe keys for every existing recipe (§6.5).

### 1.2 Out of scope (seams only)

- **Uploading the export's own image bytes.** Phase 1 _commits_ the original remote image
  URL that Paprika preserves, via the existing `storePendingImageFromUrl` path. The review
  screen does **read** the local image bytes to render thumbnails (§10.2, D26) — reading is
  not uploading. Pushing those bytes to blob storage is explicitly deferred (§11), and the
  schema is shaped to accept it later.
- Publishing any imported recipe to atproto — deferred until batch import is trusted (§17).
- Other importers (Paprika `.paprikarecipes` binary format, AnyList, Mela, plain JSON-LD
  folders). The session table's `source` column and the entry-source interface (§4.2) are
  the two seams.
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

---

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
(`ns='import.paprika'`, `key='photo_uid'`) and may be consulted as a tie-breaker, but it is
**never a primary dedupe key** (§6.2).

---

## 4. Package: `@buttery/recipe-extract/paprika`

New subpath export, reusing the microdata walker, `schemaOrgToLexicon`, and the
normalizers.

```
packages/recipe-extract/
  src/
    parse/microdata.ts          (existing, reused)
    paprika/
      recipe.ts                 parsePaprikaRecipe(html, entryName) -> PaprikaParsed
      export.ts                 walkPaprikaExport(source) -> AsyncIterable<PaprikaEntry>
      source.ts                 PaprikaEntrySource + directoryEntrySource(files)
      index.ts
  package.json                  exports: ".", "./paprika"
```

**No new dependencies.** Phase 1 reads a dropped directory, so there is no unzip step and
therefore no archive library (D19). `walkPaprikaExport` takes a `PaprikaEntrySource`
rather than bytes, so an archive-backed source can be added later without touching the
parser (§4.2, §17).

### 4.1 `parsePaprikaRecipe(html, entryName): PaprikaParsed`

Pure, synchronous, no network. Returns the standard `ExtractedRecipe` **plus** the Paprika
extras the lexicon has no home for:

```ts
export interface PaprikaParsed {
  /** Lexicon-shaped, same type every other extractor produces. */
  recipe: ExtractedRecipe;
  /** Source URL from itemprop="url", if the recipe had one. */
  sourceUrl: string | null;
  /** itemprop="author": a bare domain when sourceUrl exists, else free text. */
  sourceText: string | null;
  /** itemprop="comment" — Paprika's notes blob, paragraphs joined with "\n\n". */
  notes: string | null;
  /** Split recipeCategory, comma-separated in the export. */
  categories: string[];
  /** 0–5 from the rating element's `value` attribute; null when absent or 0. */
  rating: number | null;
  /** "Easy" / "Medium" / … verbatim. */
  difficulty: string | null;
  /** Relative in-export image path from <img src>, e.g. "Images/<uuid>/<uuid>.jpg".
   *  Resolved against the entry source for review thumbnails (§10.2, D26); never uploaded. */
  imagePath: string | null;
  /** Original remote image URL from the wrapping <a href> — what the commit path writes. */
  imageUrl: string | null;
  /** The photo-asset UUID (§3.5). Weak key, ~73% coverage. */
  photoUid: string | null;
  /** Entry name relative to the export root, for provenance and error messages. */
  entryName: string;
  /** Verbatim strings for anything lossy or dropped (§12.5). */
  raw: Record<string, unknown>;
}
```

Implementation notes, in the order they matter:

1. **Instructions must be split before the generic walker sees them.** Select the
   `[itemprop="recipeInstructions"]` container, read its child `<p>` elements, and build
   the instruction list from those. Falling through to `elementValue()` produces one
   run-on paragraph and is the single most damaging bug available in this parser.
2. Run the rest through `readItem`/`schemaOrgToLexicon` so keywords, nutrition, diet, and
   yield stay on the shared crosswalk.
3. Read the rating from the element's `value` **attribute** (`getAttribute("value")`), not
   its text. `0` means unrated → `null`.
4. `imageUrl` comes from the **wrapping `<a href>`**, `imagePath` from the `<img src>`.
   Phase 1 commits the former and renders the latter as a local preview only (§11).
5. `sourceText` is a domain when `sourceUrl` is present and free text otherwise — the
   caller must not assume which without checking `sourceUrl`.

### 4.2 `walkPaprikaExport(source): AsyncIterable<PaprikaEntry>`

Walks a **`PaprikaEntrySource`** and yields one entry per recipe file. The source is the
seam; phase 1 ships exactly one implementation.

```ts
interface PaprikaEntrySource {
  /** Every entry path, relative to whatever the user handed us, in no guaranteed order. */
  paths(): readonly string[];
  /** Decoded UTF-8 text for one path. */
  text(path: string): Promise<string>;
  /** Raw bytes for one path — used for review thumbnails only (§11). */
  bytes(path: string): Promise<Uint8Array>;
  /** Total byte size across all entries, for the guardrails below. */
  totalBytes(): number;
}

directoryEntrySource(files: File[]): PaprikaEntrySource
```

The web app builds `files` from `<input type="file" webkitdirectory>` or, on drop, by
recursing `DataTransferItem.webkitGetAsEntry()`; both give `File` handles carrying a
relative path (`webkitRelativePath` / the traversal's accumulated path). **`File` handles
are lazy** — nothing is read off disk until `text()` or `bytes()` asks, so a 15 MB export
costs nothing until parsing starts.

- **Root detection:** find the entry whose basename is `index.html` at the shallowest
  depth; its directory is the root. Fall back to "the shallowest directory containing a
  `Recipes/` folder". Never hardcode `My Recipes/`. This matters as much for a directory as
  it did for an archive — the user may drop the parent (§3.1).
- Yields `{ entryName, html }` for every `Recipes/*.html`, skipping `index.html`, anything
  under `Images/`, and `__MACOSX/` / `.DS_Store` noise. `entryName` is always relative to
  the detected root.
- Yields lazily so the UI can show real progress across a few hundred files.
- **Image bytes are read in phase 1, for previews only.** `source.bytes(imagePath)` +
  `URL.createObjectURL` renders the review thumbnails (§10.2, D26). Reading is not
  uploading: the commit path still writes `imageUrl` and nothing local reaches blob storage
  (§11). Revoke the object URLs when the review screen unmounts.
- **Guardrails:** reject an export over 200 MB total, over 5 000 entries, or any entry whose
  normalized path escapes the detected root. Path-escape rejection is cheap insurance that
  survives a future archive-backed source, where it stops being theoretical.

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
`sourceUrl === null` with a non-null `sourceText` on the no-URL fixture; `categories`
splits on comma; `imageUrl` is the remote `https://` URL and `imagePath` is the relative
one; rating reads from the attribute.

Plus an in-memory `PaprikaEntrySource` stub (a `Map<path, string>` — no filesystem, no
`File`) exercising root detection when the root is nested one and two levels deep, the
entry filters (`index.html`, `Images/`, `__MACOSX/`, `.DS_Store`), path-escape rejection,
and both size caps. `directoryEntrySource` itself gets one thin test that it maps
`webkitRelativePath` onto `paths()` correctly; everything else tests against the stub.

---

## 5. Buttery-only recipe metadata

The foundation piece. Two tables, namespaced key/value with a `jsonb` value.

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
index recipe_meta_lookup on recipe_meta (ns, key, value)
```

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
index household_recipe_meta_lookup on household_recipe_meta (household_id, ns, key, value)
```

**All Paprika import bookkeeping lives here** — it is a fact about this household's import,
not about the recipe (§2.2). Written under `ns='import.paprika'` (§12.5).

### 5.3 `recipe_import_session`

```
recipe_import_session
  id              text  primary key            -- ulid()
  household_id    text  not null references household(id)
  did             text  not null
  source          text  not null default 'paprika'
  status          text  not null               -- see below
  file_name       text                         -- the dropped folder's name, e.g. "My Recipes"
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

`source` is the seam for future importers — Mela, AnyList, a Paprika binary export.

### 5.4 Access helpers

`services/web/src/server/recipe-meta.ts`, server-only, thin:

```ts
getRecipeMeta(db, recipeId, ns): Promise<Record<string, unknown>>
setRecipeMeta(db, recipeId, ns, entries): Promise<void>          // upsert
getHouseholdRecipeMeta(db, householdId, recipeId, ns): Promise<Record<string, unknown>>
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

## 6. Dedupe

### 6.1 `source_url_key` — normalized URL, the primary signal

Deterministic, pure, lives in `packages/recipe-schemas/src/normalize/url.ts` so client and
server compute it identically. **The client computes it for the probe; the server
recomputes it before writing and never trusts the client's value.**

```
normalizeSourceUrl(raw) -> string | null
  1. parse; non-http(s) -> null
  2. host: lowercase, strip leading "www.", drop default port
  3. drop the fragment entirely
  4. drop tracking params (exact names, case-insensitive):
       utm_*  fbclid  gclid  dclid  msclkid  mc_cid  mc_eid  _ga  igshid  si
       ref  ref_src  ref_source  source  action  module  region  pgType  rank
  5. sort surviving params by name, then value
  6. path: percent-decode safely, collapse "//", strip trailing "/" unless path is "/"
  7. return "<host><path>[?<params>]"   -- no scheme; http/https are the same recipe
```

The `action`/`module`/`region`/`pgType`/`rank` entries are not speculative — they are
exactly the junk NYT Cooking appends, present in the sample export.

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

`maybe` uses `pg_trgm`'s `similarity(normalized_title, $1) > 0.85` against the household's
own recipes, scoped to the household and capped at a handful of candidates per probe.

**Risk:** requires `CREATE EXTENSION IF NOT EXISTS pg_trgm`. If the extension is
unavailable on the target Postgres, **fall back to exact normalized-title equality** rather
than failing the import — the signal is advisory. Decide this at migration time and record
which path shipped in the results doc.

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

### 6.6 Dedupe keys are written on every save, not just imports

`persistRecipeDraft` (§7.3) writes both keys for every recipe it creates, and the recipe
edit path updates them when name or ingredients change. Otherwise the corpus goes stale the
day after this ships.

---

## 7. Server contracts

### 7.1 `probeImportDuplicates` — read-only

```ts
// POST. Keys only — no recipe bodies, no ingredient text.
interface ProbeInput {
  sessionId: string;
  items: Array<{
    clientId: string; // client-minted, stable for this session
    sourceUrlKey: string | null;
    contentFp: string;
    normalizedTitle: string;
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

```ts
interface CommitChunkInput {
  sessionId: string;
  items: Array<{
    clientId: string;
    record: RecipeRecordInput; // lexicon-shaped, minus server-owned fields; MAY be user-edited (§10.2, D25)
    sourceUrl: string | null;
    attribution: AttributionInput | null; // resolved in review (§8)
    imageSourceUrl: string | null; // remote URL (§11)
    notes: string | null;
    categories: string[];
    override?: "duplicate"; // user deliberately re-imported an `in_box` match (§6.3, D23)
    paprika: { entryName: string; photoUid: string | null; rating: number | null; difficulty: string | null; raw: Record<string, unknown> };
  }>;
}

type CommitItemResult =
  | { clientId: string; status: "imported"; recipeId: string }
  | { clientId: string; status: "linked"; recipeId: string } // public_exists accepted
  | { clientId: string; status: "skipped"; reason: "duplicate" | "user" }
  | { clientId: string; status: "failed"; message: string };
```

Chunk size **25**. Each item is wrapped independently: a validation failure or a bad row
fails that item only and the chunk returns partial results. The chunk updates the session's
counters. Client drives the loop and renders progress.

`CommitItemResult` deliberately does **not** carry the entry name. The client holds the
`clientId → entryName` map from the parse and joins locally to render the "didn't make it"
list (§10.1). Do not add a server field for it.

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
- `commitImportChunk` = per-item attribution (§8) → `persistRecipeDraft` → notes,
  keywords, and sidecar rows → counters. No publish branch exists.

`resolveAttribution` gains an explicit free-text/publication path (§8) rather than being
duplicated.

**Dedupe keys are recomputed from the submitted record, never taken from the client.** §6.1
already said this for `source_url_key`; it is now equally load-bearing for `content_fp`,
because the review screen lets the user edit a recipe's name and ingredients _after_ the
probe ran (§10.2, D25). `persistRecipeDraft` derives both keys from `record` at write time,
so the stored fingerprint always describes what was actually saved.

**An edited recipe is not re-probed.** The verdict shown in review is the verdict for the
recipe as parsed. If a user edits one into an exact match of something already in the box,
the review screen will not notice — `persistRecipeDraft`'s key computation will, and the
item comes back `skipped: "duplicate"` rather than `imported`. That is the correct outcome
and the summary reports it; it is not an error and must not fail the chunk. Do not add a
re-probe on every keystroke to close this gap.

### 7.4 Publishing is structurally impossible here

`commitImportChunk` does not import `publishLocalRecipe`, does not read
`isAtprotoPublishEnabled`, and always inserts with `visibility='private'` and
`uri = null`. Add a test asserting that a full import produces zero rows with a non-null
`uri` and that `publishLocalRecipe` is never called.

### 7.5 Resumability

The session row plus per-item `clientId`s make a dropped connection recoverable: on
re-entry, the client re-probes and the server reports already-imported items as `in_box`,
so a retry converges rather than duplicating. Full resume-from-session UI is out of scope;
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

---

## 8. Attribution for the 81 URL-less recipes

`saveRecipe` rejects a record with no lexicon-valid attribution, and 81/341 recipes have no
source URL. Their source strings are cookbooks, and there are only **28 distinct values**
across those 81 recipes — including six spellings of one Gordon Ramsay title
(`Godon`, `Godron`, `ROmsay's`, `Appettie`, `Heathly`).

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
  (`ns='import.paprika'`, `key='source_text'`) regardless of what the user chose.
- Three recipes in the sample have neither a URL nor a source string. They cannot be
  auto-attributed. Surface them as a **29th group** — an "no source at all" card carrying
  the same four classification controls as every other group — and gate the import on it
  like the rest. The design draws this card with copy but no controls; that is an
  oversight, not a decision (§10.3). A card the user cannot act on is a dead end in a flow
  whose primary button stays disabled until every group is answered.
- Recipes **with** a URL are unaffected — server-built `attributionWebsite`, exactly as the
  existing import path does today.

---

## 9. Client flow

Route `/household/recipes/import`, reached from the existing `AddRecipeChooser`.
**§10 and the design files own layout and copy.** This is the state machine and the
technical constraints they have to live inside.

```
  drop folder
    → parse        walkPaprikaExport + parsePaprikaRecipe, in a Web Worker
    → keys         normalizeSourceUrl + content_fp per recipe; collapse in-batch dupes
    → probe        POST keys only → verdicts
    → review       attribution classification, duplicates, per-recipe include/exclude/edit
    → commit       chunks of 25, progress from real per-item results
    → summary      imported / linked / skipped / failed, with the failures listed
```

Technical constraints on the UI:

- **Parse in a Web Worker.** 341 files through `node-html-parser` on the main thread will
  visibly jank. The parser is pure and worker-safe by construction.
- Everything up to `commit` is in-memory and discardable; a refresh loses only work, never
  data. That now includes per-recipe edits (§7.5) — no drafts, no autosave, no local
  storage in phase 1.
- 341 rows needs virtualization or pagination; grouping by verdict (`new` / `in_box` /
  `public_exists` / `maybe`) is what makes it reviewable at all. The design supplies the
  grouping but not the windowing (§10.3).
- Failed items are listed by **export entry name** (§4.1) so the user can find them in
  Paprika; the client joins `clientId → entryName` locally (§7.2).
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
  assertion. `walkPaprikaExport` takes a `PaprikaEntrySource` so an archive-backed source
  stays a later addition rather than a rewrite (§17).
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
review screen resolves `imagePath` through `source.bytes()` + `URL.createObjectURL` and
shows the real photo — including for recipes whose remote URL is already dead, which is
precisely when the user is deciding whether to keep them. The alternative, hotlinking 293
third-party URLs from the user's browser during review, is slower, leaks a referer to 293
domains, and renders broken tiles at the worst moment.

**Reading is not uploading.** No local byte ever reaches the server in phase 1: object URLs
are created in the browser, revoked on unmount, and the commit path sends `imageSourceUrl`
and nothing else. Phase 2 (§17) is the part that uploads — it prefers the export's blob and
falls back to the remote URL, strictly additive, and the seam is already in place
(`parsePaprikaRecipe` returns `imagePath`; the entry source exposes `bytes()`).

**Rate limiting:** `storePendingImageFromUrl` performs a server-side fetch per recipe.
250 of those in a burst is a self-inflicted outbound traffic spike. Either bound
concurrency inside the commit path or make image fetching a deferred pass. Decide during
implementation and record it — do not let a chunk of 25 fire 25 uncapped outbound fetches.

---

## 12. Field mapping summary

### 12.1 Into the lexicon record

`name`, `text` (from `description`), `ingredients`, `instructions` (split, §4.1),
`recipeYield` (verbatim prose), `prepTime`/`cookTime`/`totalTime` (via `toIsoDuration`,
lossy per §3.4), `nutrition` (via the bridge; empty in practice), `keywords` (§12.3).

### 12.2 Notes → `household_recipe_note`

`itemprop="comment"` paragraphs joined with `\n\n`, authored by the importing user's DID.
The table is keyed `(household_id, recipe_id)` and Paprika has one notes blob per recipe —
a clean 1:1. Empty notes write no row.

### 12.3 Categories → keywords, not category

Paprika's categories are personal tags (§3.3), not a controlled vocabulary. For each
comma-split value:

1. Try `slugForLabel('category', value)`. The **first** match sets `recipe.recipe_category`
   (a single column). In practice almost nothing will match, which is correct.
2. **Every** value — matched or not — becomes a `recipe_keyword` row.
3. The full raw list goes to the sidecar (§12.5).

### 12.4 Rating and difficulty → dropped from the record, kept in the sidecar

Neither has a lexicon field, and inventing one is out of scope. They are **not lost**: both
land in `household_recipe_meta` under `ns='import.paprika'`, which is the right scope for
them anyway (a rating is a household's opinion, not a property of the recipe). A future
household-rating feature can read them straight out.

### 12.5 Sidecar rows written per imported recipe

`household_recipe_meta`, `ns='import.paprika'`:

| key           | value                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `session_id`  | the `recipe_import_session.id`                                                            |
| `entry_name`  | export entry name, e.g. `"Beef Bourguignon 2.html"`                                       |
| `photo_uid`   | photo-asset UUID or null (§3.5)                                                           |
| `source_text` | verbatim `itemprop="author"` string (§8.2)                                                |
| `rating`      | 0–5 or null                                                                               |
| `difficulty`  | `"Easy"` / `"Medium"` / null                                                              |
| `categories`  | the raw comma-split array                                                                 |
| `raw`         | full `PaprikaParsed.raw` — every verbatim string, including the unparseable duration text |

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

## 13. Telemetry

PostHog, server-side, one event per session (not per recipe — 341 events per import is
noise):

- `paprika_import_completed`: total, imported, linked, skipped-duplicate, skipped-user,
  overridden-duplicate (§6.3), edited-before-commit count, failed,
  distinct-source-strings-classified, duration, parse-failure count.
- `paprika_import_failed`: where it died (`parse` / `probe` / `comparison` / `commit`) and
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
- `directoryEntrySource`: `webkitRelativePath` maps onto `paths()`; `bytes()` resolves an
  `Images/<uuid>/<uuid>.jpg` path that `parsePaprikaRecipe` reported as `imagePath`.
- The page-reference split and the misspelling hint (§8.1), including all six Ramsay
  variants clustering and the hint never mutating a string.
- `normalizeSourceUrl`: the NYT tracking-param case verbatim from the export, http/https
  equivalence, `www.` stripping, param sorting, trailing slash.
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
- `commitImportChunk` partial failure: a bad item fails alone, the rest import, counters
  are correct.
- Re-running an identical import produces zero new recipes (§7.5 convergence).
- **No published record**: after a full import, zero rows have a non-null `uri`; the
  publish path is never invoked (§7.4).
- The backfill migration produces fingerprints byte-identical to the runtime function.
- Sidecar rows do not change the published record shape (§2.3).

**Manual**

- The real 341-recipe export end-to-end, twice — the second run must report 341 duplicates
  and import nothing.

---

## 15. Decisions

| #   | Decision                                                                    | Why                                                                     |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D1  | schema.org microdata parser, not hRecipe                                    | The export is microdata; the issue was wrong (§3.2)                     |
| D2  | Bespoke Paprika parser over generic `fromMicrodata`                         | Instruction splitting, attribute-valued rating, dual image paths (§3.3) |
| D3  | `@buttery/recipe-extract/paprika` subpath, not a new package                | Reuses the bridge and normalizers; no new dependency at all (§4)        |
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
   record instead of creating a private copy; accepting adds it to the box.
5. Two zip entries that resolve to the same key collapse before the probe.
6. Possible duplicates by title are flagged, never auto-skipped.
7. All 81 URL-less recipes are attributable through at most 28 classification decisions,
   and no attribution is auto-invented.
8. Every recipe with a URL gets server-built `attributionWebsite`; the raw source string is
   preserved in the sidecar in every case.
9. **No imported recipe is published to atproto.** Every row is `visibility='private'` with
   `uri = null`, and the publish path is not invoked.
10. Paprika notes appear as a household note; categories appear as keywords; rating,
    difficulty, and the full raw parse are readable from `household_recipe_meta`.
11. A commit chunk with one bad recipe imports the other 24 and reports the failure by
    export entry name.
12. Re-importing the same export imports nothing and reports 341 duplicates, **unless the
    user explicitly overrides a duplicate** (§6.3) — an overridden item imports again, and
    that is the only way a re-run creates a row.
13. Refreshing mid-import and re-running converges — no duplicate recipes.
14. `saveRecipe`'s existing behavior is unchanged by the refactor; its tests pass untouched.
15. Every existing recipe has `source_url_key` (where applicable) and `content_fp` after
    the backfill migration, byte-identical to the runtime computation.
16. The review list stays usable at 341 rows — windowed or paginated, never 293 live rows
    — and is fully keyboard-operable end to end: every group, row, chip, and dialog is
    reachable and actuable without a pointer (§10.4).
17. A member of another household cannot probe, compare, or commit into this household.
18. Review thumbnails render from local bytes, and a full import uploads zero image bytes —
    every stored image arrived through `storePendingImageFromUrl` (§11).
19. Results logged to `docs/plans/results/2026-08-09-paprika-import-results.md`.

---

## 17. Deferred / next

- **Uploading the export's image bytes** (§11) — the client already reads them for review
  thumbnails; phase 2 uploads them to blob storage and falls back to the remote URL.
  Strictly additive; the parser already returns `imagePath` and the entry source already
  exposes `bytes()`.
- **An archive-backed entry source.** Phase 1 ships `directoryEntrySource` only, but
  `walkPaprikaExport` takes a `PaprikaEntrySource` (§4.2) precisely so a `.paprikarecipes`
  binary importer — or a plain zip, if users ask for one — is a new source implementation
  rather than a parser change. **Keep the abstraction; do not inline directory traversal
  into the walker** for the sake of a few lines.
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
- **Other importers** — `.paprikarecipes` binary, Mela, AnyList. `recipe_import_session.source`
  is the seam.
- **Household ratings** — a real home for the Paprika ratings sitting in the sidecar.
- **Duration parsing for vulgar fractions** — only if it turns out to matter.
