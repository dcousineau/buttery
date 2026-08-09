# 2026-08-09 — Paprika 3 recipe library import (+ Buttery-only recipe metadata)

Status: **spec / pre-development**
Supersedes: [issue #24](https://github.com/dcousineau/buttery/issues/24) — this plan is the
living version of that ticket; the issue becomes a pointer here.
Depends on: `02-households-and-private-foundation.md` (household spine, `assertMember`),
`03-household-recipe-collection.md` (the box + rendered `recipe` layer),
`2026-08-02-create-recipes.md` (`extractRecipe`, `saveRecipe`, attribution enforcement,
`recipe_import_attempt`).
Design handoff: **not yet produced.** A design agent will build wireframes for the import
flow from §9. This plan specifies the data, parsing, and server contracts; it deliberately
under-specifies layout and copy.

> Implementer: log outcomes to `docs/plans/results/2026-08-09-paprika-import-results.md`
> (what was built, how it was verified, deliberate deviations).

---

## 1. Overview

Let a household bulk-import a **Paprika 3 "recipe box" HTML export** by dropping the zip
into the browser. The zip is unpacked and parsed **entirely client-side**; only dedupe keys
(not recipe bodies) cross the wire first; the user reviews duplicates and resolves
attribution; then the accepted recipes are committed to the household box in chunks.

Batch import is **private and local only. It never writes to atproto.** Not as a default,
not behind a checkbox — the commit path has no publish branch at all (§7.4).

This plan also introduces a piece of foundation the app has needed for a while and will
need repeatedly: **first-class Buttery-only recipe metadata** (§5), global and
per-household, that deliberately never appears in an `exchange.recipe.recipe` record.
Paprika import is its first consumer; LLM enhancement of un-editable public records is the
next.

### 1.1 In scope

1. `@buttery/recipe-extract/paprika` — a Paprika-specific parser plus a zip walker,
   pure and browser-safe (§4).
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

- **Images from inside the zip.** Phase 1 uses the original remote image URL that Paprika
  preserves, via the existing `storePendingImageFromUrl` path. Uploading the zip's own
  image bytes is explicitly deferred (§10), and the schema is shaped to accept it later.
- Publishing any imported recipe to atproto — deferred until batch import is trusted (§16).
- Other importers (Paprika `.paprikarecipes` binary format, AnyList, Mela, plain JSON-LD
  folders). The session table's `source` column is the seam.
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

The zip a user produces will have some wrapping directory. **Do not assume `My Recipes/` —
locate `index.html` and treat its directory as the root** (§4.2).

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
| `comment`                             | Paprika's notes field                                                                                                                                               | → `household_recipe_note` (§11.2)                                                                 |
| `recipeCategory`                      | **comma-separated personal tags**, 43 distinct: `Export to Weeknight dinner, Regular Meals`, `Healthish`, `Marinated Lunch Salads`; 128 recipes carry more than one | split on comma → keywords, not category (§11.3)                                                   |
| `recipeYield`                         | free text: `Serves 6`, `Yield 10 to 12 servings`, `4`                                                                                                               | lexicon `recipeYield` is free text — pass through verbatim                                        |
| `totalTime` / `cookTime` / `prepTime` | **human text, not ISO 8601**: `45 min`, `1 1/2 hours plus cooling time`                                                                                             | `toIsoDuration` handles most; see §3.4                                                            |
| `aggregateRating`                     | `<p itemprop="aggregateRating" class="rating" value="0">` — value in an **attribute**, element text empty                                                           | generic walker drops it (correctly). Personal 0–5 rating; §11.4                                   |
| `difficulty`                          | non-schema.org itemprop, `Easy` / `Medium`                                                                                                                          | §11.4                                                                                             |
| `description`                         | present on a minority                                                                                                                                               | direct → lexicon `text`                                                                           |
| `image`                               | `<img itemprop="image" src="Images/<uuid>/<uuid>.jpg">`, wrapped in `<a href="<original remote URL>">`                                                              | §10 — phase 1 uses the `<a href>`, not the `src`                                                  |
| nutrition                             | markup present in the template; **no recipe in the sample export populates it**                                                                                     | map it anyway (the bridge already does), expect nulls                                             |

### 3.4 Known lossy edges — accept, don't fix

- `toIsoDuration("1 1/2 hours plus cooling time")` yields `PT1H`: the hour regex matches
  `1`, the vulgar fraction and the trailing prose are dropped. **Acceptable** — an
  approximate time beats none, and the raw string is preserved in the sidecar (§11.5).
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

New subpath export. Keeps the zip dependency off the URL-scrape path while reusing the
microdata walker, `schemaOrgToLexicon`, and the normalizers.

```
packages/recipe-extract/
  src/
    parse/microdata.ts          (existing, reused)
    paprika/
      recipe.ts                 parsePaprikaRecipe(html, entryName) -> PaprikaParsed
      archive.ts                walkPaprikaExport(bytes) -> AsyncIterable<PaprikaEntry>
      index.ts
  package.json                  exports: ".", "./paprika"
```

Dependency added: **`fflate`** (~8 kB gzipped, browser + node, no WASM). Declared as a
dependency of the package but only reachable through the `./paprika` subpath, so the
existing scrape callers' bundle is unchanged. Verify that with a bundle-size assertion in
the web app build, or at minimum a comment plus a manual check recorded in the results doc.

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
  /** Relative in-zip image path from <img src>, e.g. "Images/<uuid>/<uuid>.jpg". */
  imageZipPath: string | null;
  /** Original remote image URL from the wrapping <a href> — what phase 1 uses. */
  imageUrl: string | null;
  /** The photo-asset UUID (§3.5). Weak key, ~73% coverage. */
  photoUid: string | null;
  /** Zip entry name, for provenance and user-facing error messages. */
  entryName: string;
  /** Verbatim strings for anything lossy or dropped (§11.5). */
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
4. `imageUrl` comes from the **wrapping `<a href>`**, `imageZipPath` from the `<img src>`.
   Both are captured now even though phase 1 only consumes the former (§10).
5. `sourceText` is a domain when `sourceUrl` is present and free text otherwise — the
   caller must not assume which without checking `sourceUrl`.

### 4.2 `walkPaprikaExport(bytes): AsyncIterable<PaprikaEntry>`

Unzips in memory with `fflate` and yields one entry per recipe file.

- **Root detection:** find the entry whose basename is `index.html` at the shallowest
  depth; its directory is the root. Fall back to "the shallowest directory containing a
  `Recipes/` folder". Never hardcode `My Recipes/`.
- Yields `{ entryName, html }` for every `Recipes/*.html`, skipping `index.html`, anything
  under `Images/`, and `__MACOSX/` / `.DS_Store` noise.
- Yields lazily so the UI can show real progress across a few hundred files.
- Image bytes are **not** read in phase 1. Expose an `images: Map<path, Uint8Array>`
  accessor (or a second generator) that phase 1 does not call — the shape is there for §10.
- **Guardrails:** reject a zip over 200 MB uncompressed, over 5 000 entries, or any entry
  whose normalized path escapes the root (zip-slip). These are cheap and this code eats
  user-supplied archives.

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
splits on comma; `imageUrl` is the remote `https://` URL and `imageZipPath` is the relative
one; rating reads from the attribute. Plus a small synthetic zip exercising root detection,
zip-slip rejection, and the entry filters.

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
not about the recipe (§2.2). Written under `ns='import.paprika'` (§11.5).

### 5.3 `recipe_import_session`

```
recipe_import_session
  id              text  primary key            -- ulid()
  household_id    text  not null references household(id)
  did             text  not null
  source          text  not null default 'paprika'
  status          text  not null               -- see below
  file_name       text
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

| Corpus                                                                                  | Verdict         | Default action                                                                                                                             |
| --------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| This household's box (`household_recipe` join `recipe`) — URL key or fingerprint match  | `in_box`        | **Skip.** "You definitely have this already."                                                                                              |
| Public atproto index (`recipe.visibility='public' and uri is not null`) — URL key match | `public_exists` | **Offer the link.** Add the existing public recipe to the box instead of creating a private copy. Per-recipe choice, plus an apply-to-all. |
| Normalized-title match only, no key match                                               | `maybe`         | **Import, flagged.** Soft warning in review; never auto-skip.                                                                              |
| Nothing matches                                                                         | `new`           | Import.                                                                                                                                    |
| Two zip entries resolving to the same key                                               | `dupe_in_batch` | Collapse client-side before the probe; report the count.                                                                                   |

Other households' private recipes are never consulted (§2.2).

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

type ProbeVerdict =
  | { clientId: string; verdict: "new" }
  | { clientId: string; verdict: "in_box"; existingRecipeId: string }
  | { clientId: string; verdict: "public_exists"; existingRecipeId: string }
  | { clientId: string; verdict: "maybe"; candidates: Array<{ recipeId: string; name: string }> };
```

Read-only, no writes beyond advancing the session to `reviewing`. Reveals only recipes the
caller's household can already see, or public records — no new information leaks. Sized for
one call per ~200 items; the client chunks if larger.

### 7.2 `commitImportChunk`

```ts
interface CommitChunkInput {
  sessionId: string;
  items: Array<{
    clientId: string;
    record: RecipeRecordInput; // lexicon-shaped, minus server-owned fields
    sourceUrl: string | null;
    attribution: AttributionInput | null; // resolved in review (§8)
    imageSourceUrl: string | null; // remote URL (§10)
    notes: string | null;
    categories: string[];
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

Sensible affordances, left to design: a suggested split of `Ottolenghi Simple pg 174` into
title + page, and reuse of a previously entered publication for a similar string. Neither
is required for correctness.

### 8.2 Non-negotiables

- **Never auto-invent attribution.** Writing a cookbook title into the `author` field, or a
  page reference into a person's `name`, produces wrong data that publishes later if the
  user ever makes the recipe public. This was considered and rejected.
- The raw source string is **always** preserved verbatim in the sidecar
  (`ns='import.paprika'`, `key='source_text'`) regardless of what the user chose.
- Three recipes in the sample have neither a URL nor a source string. They cannot be
  auto-attributed; surface them as their own group requiring an explicit choice or a skip.
- Recipes **with** a URL are unaffected — server-built `attributionWebsite`, exactly as the
  existing import path does today.

---

## 9. Client flow

Route `/household/recipes/import`, reached from the existing `AddRecipeChooser`. Design
agent owns layout and copy; this is the state machine and the technical constraints.

```
  drop zip
    → parse        walkPaprikaExport + parsePaprikaRecipe, in a Web Worker
    → keys         normalizeSourceUrl + content_fp per recipe; collapse in-batch dupes
    → probe        POST keys only → verdicts
    → review       duplicates, attribution classification, per-recipe include/exclude
    → commit       chunks of 25, progress from real per-item results
    → summary      imported / linked / skipped / failed, with the failures listed
```

Technical constraints on the UI:

- **Parse in a Web Worker.** 341 files through `node-html-parser` on the main thread will
  visibly jank. The parser is pure and worker-safe by construction.
- Everything up to `commit` is in-memory and discardable; a refresh loses only work, never
  data.
- 341 rows needs virtualization or pagination; grouping by verdict (`new` / `in_box` /
  `public_exists` / `maybe`) is what makes it reviewable at all.
- Failed items are listed by **zip entry name** (§4.1) so the user can find them in Paprika.
- Bulk actions are needed at this scale: select-all-new, skip-all-duplicates,
  link-all-public.

### 9.1 UX questions for the design agent

1. Is attribution classification (§8) a distinct step before review, or a section within it?
2. Do `maybe` matches sit inline with a warning badge, or in their own group?
3. What does a partially-failed import offer — retry the failures, or just report them?
4. Is a completed import's summary reachable later (the session row supports it), or
   transient?

---

## 10. Images — phase 1 is remote-URL only

**Decision: use the original remote URL, defer zip bytes.**

Paprika preserves the source image URL in the `<a href>` wrapping each `<img>`, so phase 1
passes it as `imageSourceUrl` and reuses `storePendingImageFromUrl` — the exact path the
existing single-recipe import already uses, SSRF-guarded and size-capped. No new upload
endpoint, no multi-megabyte client uploads.

Known cost, accepted: images whose source is dead, paywalled, or hotlink-blocked are lost,
and 91 recipes have no image at all. The zip holds 11 MB of image bytes that phase 1 does
not use.

The seam is already in place — `parsePaprikaRecipe` returns `imageZipPath` and
`walkPaprikaExport` can surface image bytes. Phase 2 (§16) prefers the zip blob and falls
back to the remote URL, which is strictly additive.

**Rate limiting:** `storePendingImageFromUrl` performs a server-side fetch per recipe.
250 of those in a burst is a self-inflicted outbound traffic spike. Either bound
concurrency inside the commit path or make image fetching a deferred pass. Decide during
implementation and record it — do not let a chunk of 25 fire 25 uncapped outbound fetches.

---

## 11. Field mapping summary

### 11.1 Into the lexicon record

`name`, `text` (from `description`), `ingredients`, `instructions` (split, §4.1),
`recipeYield` (verbatim prose), `prepTime`/`cookTime`/`totalTime` (via `toIsoDuration`,
lossy per §3.4), `nutrition` (via the bridge; empty in practice), `keywords` (§11.3).

### 11.2 Notes → `household_recipe_note`

`itemprop="comment"` paragraphs joined with `\n\n`, authored by the importing user's DID.
The table is keyed `(household_id, recipe_id)` and Paprika has one notes blob per recipe —
a clean 1:1. Empty notes write no row.

### 11.3 Categories → keywords, not category

Paprika's categories are personal tags (§3.3), not a controlled vocabulary. For each
comma-split value:

1. Try `slugForLabel('category', value)`. The **first** match sets `recipe.recipe_category`
   (a single column). In practice almost nothing will match, which is correct.
2. **Every** value — matched or not — becomes a `recipe_keyword` row.
3. The full raw list goes to the sidecar (§11.5).

### 11.4 Rating and difficulty → dropped from the record, kept in the sidecar

Neither has a lexicon field, and inventing one is out of scope. They are **not lost**: both
land in `household_recipe_meta` under `ns='import.paprika'`, which is the right scope for
them anyway (a rating is a household's opinion, not a property of the recipe). A future
household-rating feature can read them straight out.

### 11.5 Sidecar rows written per imported recipe

`household_recipe_meta`, `ns='import.paprika'`:

| key           | value                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `session_id`  | the `recipe_import_session.id`                                                            |
| `entry_name`  | zip entry name, e.g. `"Beef Bourguignon 2.html"`                                          |
| `photo_uid`   | photo-asset UUID or null (§3.5)                                                           |
| `source_text` | verbatim `itemprop="author"` string (§8.2)                                                |
| `rating`      | 0–5 or null                                                                               |
| `difficulty`  | `"Easy"` / `"Medium"` / null                                                              |
| `categories`  | the raw comma-split array                                                                 |
| `raw`         | full `PaprikaParsed.raw` — every verbatim string, including the unparseable duration text |

`recipe_meta`, `ns='dedupe'`: `source_url_key`, `content_fp`.

### 11.6 Deviation from the original answer: no `recipe_import_attempt` rows

The initial intent was to preserve the raw parse on `recipe_import_attempt.parsed`. That
table's `url` column is `NOT NULL` and **24% of Paprika recipes have no URL**, so a batch
would need 341 rows with fabricated URLs. Since `household_recipe_meta` (§5.2) did not
exist when that call was made and is a strictly better home — household-scoped, queryable,
attached to the recipe rather than to a scrape attempt — the raw parse goes there instead
and batch import writes no `recipe_import_attempt` rows at all. The session table covers
the audit need. **Flagged explicitly because it contradicts an earlier decision.**

---

## 12. Telemetry

PostHog, server-side, one event per session (not per recipe — 341 events per import is
noise):

- `paprika_import_completed`: total, imported, linked, skipped-duplicate, skipped-user,
  failed, distinct-source-strings-classified, duration, parse-failure count.
- `paprika_import_failed`: where it died (`parse` / `probe` / `commit`) and the message.

No recipe names, URLs, or ingredient text in properties.

---

## 13. Testing

**Unit** (`packages/recipe-extract`)

- The four real fixtures, per §4.3, with the instruction-splitting assertion as the
  headline test.
- `walkPaprikaExport`: root detection, entry filtering, zip-slip rejection, size caps.
- `normalizeSourceUrl`: the NYT tracking-param case verbatim from the export, http/https
  equivalence, `www.` stripping, param sorting, trailing slash.
- `content_fp`: stable under ingredient reordering and whitespace/case changes; different
  under a name change; **identical between the WebCrypto and node:crypto paths**.

**DB** (`services/web/src/server`)

- `probeImportDuplicates` returns each of the four verdicts against seeded data.
- A household cannot probe or commit into another household (`assertMember`).
- The probe never returns another household's private recipe, including on an exact
  fingerprint match.
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

## 14. Decisions

| #   | Decision                                                                    | Why                                                                        |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| D1  | schema.org microdata parser, not hRecipe                                    | The export is microdata; the issue was wrong (§3.2)                        |
| D2  | Bespoke Paprika parser over generic `fromMicrodata`                         | Instruction splitting, attribute-valued rating, dual image paths (§3.3)    |
| D3  | `@buttery/recipe-extract/paprika` subpath, not a new package                | Reuses the bridge and normalizers; `fflate` stays off the scrape path (§4) |
| D4  | Namespaced key/value + `jsonb` sidecar                                      | Velocity now; typed columns are the acknowledged future (§5.5)             |
| D5  | Paprika bookkeeping is household-scoped                                     | It's a fact about this household's import, not the recipe (§2.2)           |
| D6  | Normalized URL primary, content fingerprint secondary, fuzzy title advisory | URL alone leaves 24% unchecked (§6)                                        |
| D7  | No cross-household private dedupe                                           | Leaks existence of private recipes (§2.2)                                  |
| D8  | Photo UID is never a primary key                                            | It's a photo-asset id at 73% coverage, not a recipe id (§3.5)              |
| D9  | Bulk-classify the 28 distinct source strings                                | 28 decisions instead of 81; never invents attribution (§8)                 |
| D10 | Read-only probe before commit                                               | Accurate review before any write; keys-only payload (§7.1)                 |
| D11 | Chunks of 25 with per-item results                                          | Real progress, isolated failures, convergent retry (§7.2)                  |
| D12 | Batch import cannot publish, structurally                                   | Irreversible + public + best-effort parse (§2.1)                           |
| D13 | Remote image URLs in phase 1                                                | Reuses an existing guarded path; zip bytes deferred (§10)                  |
| D14 | Categories → keywords, not the category vocab                               | They're personal tags (§11.3)                                              |
| D15 | Rating/difficulty in the sidecar, not the record                            | No lexicon field; household scope is right anyway (§11.4)                  |
| D16 | No `recipe_import_attempt` rows for batch                                   | `url` is NOT NULL; contradicts an earlier call, see §11.6                  |
| D17 | Dedupe keys written on every save                                           | Otherwise the corpus is stale immediately (§6.6)                           |
| D18 | Backfill migration is mandatory                                             | Without it the first import duplicates the whole box (§6.5)                |

---

## 15. Acceptance criteria

1. A Paprika 3 export zip dropped on `/household/recipes/import` parses fully client-side,
   with no recipe body sent to the server before the review step.
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
11. A commit chunk with one bad recipe imports the other 24 and reports the failure by zip
    entry name.
12. Re-importing the same export imports nothing and reports 341 duplicates.
13. Refreshing mid-import and re-running converges — no duplicate recipes.
14. `saveRecipe`'s existing behavior is unchanged by the refactor; its tests pass untouched.
15. Every existing recipe has `source_url_key` (where applicable) and `content_fp` after
    the backfill migration, byte-identical to the runtime computation.
16. `fflate` does not appear in the bundle for the URL-scrape path.
17. A member of another household cannot probe or commit into this household.
18. Results logged to `docs/plans/results/2026-08-09-paprika-import-results.md`.

---

## 16. Deferred / next

- **Images from the zip** (§10) — client extracts bytes, uploads to blob storage, falls
  back to the remote URL. Strictly additive; the parser already returns `imageZipPath`.
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
