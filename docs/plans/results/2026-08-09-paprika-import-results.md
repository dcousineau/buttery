# Paprika import — build log

> Plan: [`docs/plans/2026-08-09-paprika-import.md`](../2026-08-09-paprika-import.md)
> Branch: `feat/paprika-import`
> Implemented 2026-08-09/10.

## Status

Everything in §1.1 is built. §1.2 and §17 are untouched, as intended.

Commits:

| Commit    | What                                                             |
| --------- | ---------------------------------------------------------------- |
| `a839da6` | dedupe key helpers, importer seam, meta tables, ESLint boundary   |
| `28e1d82` | Paprika importer, `persistRecipeDraft`, dedupe backfill           |
| `8320295` | import pipeline (§7) and review UI (§9–§11)                       |
| `caa9a0a` | entry point in `AddRecipeChooser`, this build log                 |
| (below)   | the verification pass and the defects it found                    |

Test state at time of writing:

```
pnpm -r test                     → 458 passed | 126 skipped   (38 files)
pnpm --filter @buttery/web test:db                    → 126 passed (5 files)
pnpm --filter @buttery/atproto-cron-sync test:db      →   4 passed (1 file)
pnpm -r typecheck                → clean
pnpm lint                        → clean
```

The 126 skipped in `pnpm -r test` are the DB suites skipping themselves for want of
`DATABASE_URL`; they are the same ones that pass under the two `test:db` commands.

Verified end to end in the browser against the real 341-recipe export at
`~/Documents/My Recipes`: 341 parsed in a worker, 30 imported, 0 failed, clean console.

One note for anyone auditing the dev database afterwards: a `link` writes the import sidecar
onto an **already-public** recipe, so "count the recipes tagged with an import session that
have a `uri`" is not a test of §7.4 and will legitimately return non-zero. The `public_exists`
link path is exactly what puts them there. To check §7.4, look at recipes the session
*created* — every one of them has `uri = null` and `visibility = 'private'`.

---

## What shipped

### Foundations (`a839da6`)

| File                                                       | What                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/recipe-schemas/src/normalize/url.ts`             | `normalizeSourceUrl` — §6.1's eight steps                    |
| `packages/recipe-schemas/src/normalize/fingerprint.ts`     | `contentFingerprint`, `contentFingerprintInput` (§6.2)       |
| `packages/recipe-extract/src/import/types.ts`              | `RecipeImporter` / `ImportCandidate` / `EntrySource` (§2.5)  |
| `packages/recipe-extract/src/import/entry-source.ts`       | directory + in-memory sources, size and path-escape guards   |
| `…/migrations/…_create_recipe_meta_and_import_session.ts`  | the three sidecar tables (§5.1–§5.3)                         |
| `eslint.config.js`                                         | the §2.5 boundary rule + its single exemption                |
| `services/web/src/components/ui/progress.tsx`              | the `Progress` primitive (§10.2 D26)                         |

`contentFingerprint` uses `globalThis.crypto.subtle` in every environment rather than
WebCrypto in the browser and `node:crypto` on the server. §14 asks for the two to be
byte-identical; one implementation makes that true by construction instead of by test.

### Paprika importer (`28e1d82`, §4)

`packages/recipe-extract/src/paprika/` — `recipe.ts`, `export.ts`, `importer.ts`, plus
five fixtures copied verbatim out of the real export.

Two details carry most of this parser's risk and both have dedicated tests:

- `recipeInstructions` is one `<div>` of N `<p class="line">`. The generic `elementValue()`
  path collapses it into one run-on paragraph. 308 of the 341 recipes have a
  multi-paragraph block; all 308 split correctly.
- `localImagePath` needs two hops. The raw `<img src>` is relative to the recipe HTML
  file; `EntrySource` keys are relative to whatever the user dropped. The test asserts the
  resolved path is a key the source actually holds rather than comparing to a string
  literal — the bug produces a plausible path that simply is not there.

`readItem` / `elementValue` are now exported from `parse/microdata.ts` so the Paprika
parser reuses the one microdata reader rather than forking it (§2.4).

### Write path (`28e1d82`, §5.4 / §7.3)

- `services/web/src/server/recipe-meta.ts` — the sidecar accessors. The batch setters are
  load-bearing, not sugar: a commit chunk writes ~6 keys across 25 recipes in one statement.
- `services/web/src/server/recipes-write.ts` — `persistRecipeDraft` extracted from `runSave`:
  assemble + validate, mint a ULID, insert, write dedupe keys, queue the pending image. No
  dedupe check, no publish.

Dedupe keys are always derived from the submitted record inside the insert's own
transaction, so a recipe cannot exist without them.

`insertLocalRecipe` now reuses a caller-supplied transaction. Kysely's
`Transaction#transaction()` throws, so without this the chunk commit could not have called
it at all.

### Backfill and the third writer (`28e1d82`, §6.5 / §6.6)

- `…/migrations/…_backfill_recipe_dedupe_keys.ts` — computes keys in TypeScript through the
  shared helpers, batched by keyset over `recipe.id`. The per-recipe computation is an
  exported pure function, so §16.15's byte-identity is provable in a plain unit test.
  4255 recipes → 8327 rows (4255 `content_fp`, 4072 `source_url_key`). `down` removes only
  `ns='dedupe'`.
- `services/atproto-cron-sync/src/render.ts` — writes both keys on every render, and
  **replaces** rather than upserts, so a removed URL leaves no stale row.

The cron service had no test setup at all; it now has the same `unit`/`db` vitest split as
the web app.

### Server pipeline (`8320295`, §7)

`services/web/src/server/recipe-import.ts` — `openImportSession`, `probeImportDuplicates`,
`commitImportChunk`, `getImportComparison`, `finalizeImportSession`, `failImportSession`.

- The probe answers a whole batch in four statements: in-box keys, public keys, one
  `unnest` + `LATERAL` fuzzy-title pass over the existing trigram index, and a batched
  handle lookup. No per-item queries.
- Commit runs **one transaction per item**, not per chunk — §7.5's resumability requires a
  mid-chunk failure to leave everything before it committed.
- Meta validation is a boundary: values over 8 KB, non-object shapes, and the four reserved
  keys are rejected on both the `import` and `link` item variants.
- Images are fetched after the transactions close, four at a time. Holding 25 row-locked
  transactions open across 25 outbound HTTP fetches is the obvious way to write this and
  the wrong one.

### Client (`8320295`, §9–§11)

`routes/household.recipes_.import.tsx`, `lib/recipe-import/` (machine, worker, registry,
api, source grouping, diff, image cache), `components/recipes/import/` (12 components).

`drop → reading → review → committing → done`, with compare and editor overlays. Parsing
and key computation run in a Web Worker; 341 files on the main thread freezes the tab.

`AddRecipeChooser` gained a fourth option ("Bring in your recipe box") — without it the
route was unreachable from the UI.

---

## The verification pass, and what it found

Everything above was walked against §16's 23 acceptance criteria by a reviewer that read the
code rather than the commit messages. It found six real defects and several criteria that
were true but pinned by nothing. All are fixed; the notable ones:

**A replayed override duplicated the recipe.** The override path skipped the duplicate
re-check entirely, and §7.5 explicitly allows a chunk whose response was lost to be replayed.
Fixed with a real idempotency ledger: `client_id` is now a persisted sidecar key, and every
commit takes a transaction-scoped advisory lock on `(household, session, client)` and returns
the prior recipe id if there is one. Two concurrent replays serialize and the loser sees the
winner's row.

**A full re-import dead-ended before the summary.** With every recipe already in the box,
nothing was selected, the primary button disabled itself, and the user never reached the done
screen — §16.12's "reports 341 duplicates" failed end to end. An all-skip commit is a
legitimate outcome, not a blocked state.

**The counters were half-derived.** §7.7 says derived and never incremented, but
`skipped_count` came from a number the client sent, so a replay inflated it. Skips now travel
as real `action: "skip"` items — which is what §7.2 always intended them for — and land in a
`recipe_import_skip` table keyed `(session_id, client_id)`, so both skip counts are derived
from rows and a replay is idempotent by primary key. `finalizeImportSession` no longer accepts
a client skip number at all.

**Windowing had been substituted for, not implemented.** The review list rendered all 341 rows
and leaned on `content-visibility`, which skips paint but not reconciliation, element
allocation, or the eager `createObjectURL` calls — which is why the object-URL cap had been
raised to 1024 to stop thumbnails going blank. Replaced with a real windowed list (no
dependency, ~130 lines): 287 mounted rows → 31, 3802 DOM nodes → 648, 353 object URLs in one
mount pass → 68 across a full scroll sweep, and 293 revocations under live `<img>` elements →
zero. The cap came back down to 128. Keyboard navigation across the window boundary is pinned
by tests and was checked by hand.

**Two terminal-state holes.** A finalize arriving after a failure flipped the session back to
`complete` and emitted a second telemetry event; a chunk arriving after finalize still wrote
rows. Both guards now share one terminal-status set.

**A literal NUL byte made a source file binary to git.** `source-groups.ts` wrote `"\0…"` as a
raw 0x00, so the whole file showed up as `Bin 0 -> 7725 bytes` and was invisible in diffs and
review. It is a ` ` escape now — same runtime value, ordinary text file.

Test gaps closed at the same time: an ESLint-API test that pins the §2.5 boundary rule itself
(it fired, but nothing kept it firing — a flat-config reorder would have disabled D30 silently
with `pnpm lint` green), 13 DB tests for `saveRecipe` (which had *zero*, making §16.14's "its
tests pass untouched" vacuous), 17 tests proving every server function actually calls
`assertMember` before touching the database, and an opt-in corpus test that walks the real
341-recipe export when it is present and skips cleanly when it is not.

Two criteria could not be met as written and are documented rather than forced:

- **§16.22** wants a fixture importer *registered* without editing shipped modules, but the id
  list feeds both the client registry's exhaustiveness check and the server's Zod enum, so
  registration necessarily touches two files. The substance of the criterion is already true —
  a fixture importer can be driven through parse → probe → commit with no shipped-module edits,
  because `useImportSession` takes a `RecipeImporter` object and `runOpenImportSession` takes a
  free-text id. The criterion should say "driven", not "registered".
- **§16.2's "all 341 parse"** is now covered by the corpus test, but only on a machine that has
  the export. CI cannot assert it.

---

## Deliberate deviations

1. **`ImportCandidate` / `ImportParseFailure` carry an explicit `kind` discriminant**, which
   §2.5's interface block does not show. Parse results cross a worker boundary as structured
   clones, where a duck-typed guard silently flips the day a field is added, with no type
   error to catch it.

2. **`RecipeImporter` gained `dropCopy`.** The drop screen's copy is importer-specific but
   the need for it is not, so it lives on the interface and the component renders whatever
   the registry hands it. Without this the route would have had to name an importer.

3. **`CommitItem` carries `sourceText`.** §12.5 requires the reserved `source_text` sidecar
   row, `meta` cannot carry it (the key is rejected), and the lexicon record has no field
   for it. §7.2's item shape had nowhere to put it.

4. **`linked` has no column in `recipe_import_session`.** The schema is fixed by §5.3, so
   `imported_count` counts created recipes only; `linked` is derived and returned in the
   finalize result and the telemetry event.

5. **`skipped_count` / `failed_count` come from the client's reconciled outcome**, not from
   a query. A skip writes no row, so nothing in the database can answer how many there were.
   `imported` and `linked` are strictly derived, per §7.7.

6. **Images are not subject to the `scrape:<did>` limiter.** That limiter is 1/60s for
   user-initiated page scrapes; applying it to an import would turn 250 thumbnails into four
   hours. The import path is bounded by concurrency (4) instead.

7. **Validation now happens after the public-duplicate check** in `saveRecipe`, because
   `$safeValidate` moved inside `persistRecipeDraft`. One observable consequence: a
   submission that is *both* lexicon-invalid *and* a duplicate of a public record now returns
   `duplicate` where it returned `invalid`. Every other input returns what it did before.

8. **Windowing is hand-written.** §9 requires virtualization and D3 forbids a new dependency,
   so the review list uses a ~130-line hook over a measured fixed row height. Arrow/Home/End
   navigation has to scroll a row into view *and* mount it in the same render, which is the
   part naive windowing breaks.

9. **`action: "skip"` carries a reason.** §7.2's item shape has none, but §10.2/D24 requires
   the done screen to separate "already yours" from "you skipped", and `dupe_in_batch` — two
   copies inside one drop, neither in the box — is invisible to the server, so it cannot infer
   the label. The *counts* are still derived from rows; only the label comes from the client,
   and an unrecognized one degrades to `"user"` rather than failing the other 24 items.

10. **`client_id` is a fifth reserved sidecar key.** §12.5 names four. The idempotency ledger
    needs a stable per-entry identity, and leaving the key unreserved would let an importer
    overwrite it.

---

## Corrections owed to the plan

Two of §3's ground-truth numbers are off against the actual export:

- §3.3 says 81 of 341 recipes have no URL. The real count is **92** (27%).
- §3.4 says `toIsoDuration("1 1/2 hours plus cooling time")` yields `PT1H`. It actually
  yields **`PT2H`** — the regex takes the `2` out of `1/2`. Still lossy, still accepted, raw
  string still preserved; the fixture test asserts the real value.

And one acceptance criterion cannot be met as written:

- **§16.22** asks that a fixture importer be *registered* without editing shipped modules.
  Registration is by definition two edits — an id in `#/lib/recipe-import-ids` and a line in
  `importers.ts` — so no seam can satisfy it. The substance it is reaching for is already
  true and is what the boundary test asserts: a fixture importer can be **driven** end to end
  through parse → probe → commit with no shipped module touched, because every stage below
  the registry takes a `RecipeImporter` value. Recommend amending the criterion to "driven".

---

## Known gaps

- **Phone layout was not attempted.** The three-pane review screen is desktop-only, matching
  the comp. §10.3 left this open and it stays open.
- **Screen-reader behavior is not verified by a human.** Roles, labels, and a throttled live
  region are in the markup per §10.4, but nobody drove VoiceOver through the flow.
- **No component tests.** The repo has no `*.test.tsx` precedent (`@testing-library/react` is
  an unused devDependency), so the state machine, worker protocol, source grouping, diff, and
  image cache are covered as plain unit tests and the components are not. Establishing that
  convention is a separate decision.
- **Image upload is still phase 2** (§17). The commit sends the remote URL; local bytes are
  previewed and then discarded. Recipes with a user-added photo and no remote original
  (about 1 in 12 of this export) arrive with no image.
- **10 of the 341 recipes cannot be saved at all**, and land in "didn't make it" with the
  server's real message — e.g. `instructions.0: string too big (maximum 1000, got 1120)`.
  These are the lexicon's own length caps, hit by recipes whose steps are genuinely one long
  paragraph. The plan is silent on it, and the two ways out are both bigger than this seam:
  raise the caps on a published lexicon (a cross-app compatibility decision), or split long
  steps on the way in (a lossy edit to the user's data made without asking). Left failing,
  visibly, with the reason on screen.

## Unrelated bug found, not fixed

`motion-safe:animate-timer-shake`, `motion-safe:animate-cook-blob-a`,
`motion-safe:animate-cook-blob-b`, and `motion-safe:animate-cook-alarm-flash` emit **zero
CSS**. The `.animate-*` classes in `styles.css` are declared unlayered and are not Tailwind
utilities, so no variant can reach them — the header timer shake, the cook-mode blobs, and
the alarm flash never animate. The fix is the same one-line `@theme inline` registration
that `progress-indeterminate` needed. Out of scope here; worth its own change.

---

## How to run it

```bash
# unit tests — needs nothing running
pnpm -r test

# DB suites — the dev stack must be up; railway injects DATABASE_URL
pnpm --filter @buttery/web test:db
pnpm --filter @buttery/atproto-cron-sync test:db

# typecheck + lint
pnpm -r typecheck && pnpm lint

# the app
pnpm dev   # → http://127.0.0.1:3000
```

---

## Manual testing plan

The automated suites cover the logic; these are the things only a human at a keyboard can
confirm. A real Paprika 3 export lives at `~/Documents/My Recipes` (341 recipes, 250 image
directories, 92 with no URL).

**Before you start.** Bring up `pnpm dev`, sign in, and note how many recipes your household
box has. Several checks below compare against that number.

### 1. Getting there

1. Recipes → **Add** → the dialog should show four options, the last being "Bring in your
   recipe box".
2. "Start an import" → `/household/recipes/import`, titled "Import from Paprika", with your
   household's name in the lede.
3. The page should own the viewport — no double scrollbar, no page-level scroll.

### 2. The drop screen

1. **Drag the whole `My Recipes` folder** onto the dropzone. This is the real path; the
   "Choose a folder" button is the fallback.
2. Drop something wrong on purpose — a single `.html` file, a folder of photos, an empty
   folder. Each should produce a specific, readable message and leave you able to try again.
3. Drop the folder while the dropzone is focused via keyboard (Tab to it, Space/Enter to open
   the picker). The whole flow must be operable without a mouse (§10.4).

### 3. Reading

1. 341 files should parse with a moving progress bar and a count. **The tab must stay
   responsive** — scroll the page, resize the window. If it locks up, the worker is not doing
   the work.
2. Hit **Cancel** partway. It should stop promptly and return you to the drop screen with
   nothing written.
3. Re-drop and let it finish. Parse failures, if any, roll into a "didn't make it" list —
   note the count.

### 4. Review — the part worth the most attention

1. **Duplicates.** Your existing box has recipes that overlap this export. Confirm the rail's
   duplicate group is non-empty and that each card names the recipe it matched.
2. **Compare.** Open a duplicate's compare view. Ingredients and instructions should be
   side-by-side and the differences legible. Close it with Escape.
3. **The counts don't sum, on purpose** — a recipe can be in two groups. The rail says so;
   check the wording reads as intentional rather than as a bug.
4. **Sources.** ~34 distinct source strings, including a group for recipes with no source at
   all. For each group pick one of the four choices. Confirm:
   - "Publication" requires both title and author before the group counts as answered;
   - the no-source group offers the same choices, not a disabled card;
   - "Skip these" removes them from the import rather than importing them unattributed.
5. **Edit one recipe** before committing — change its title, drop an ingredient. The change
   must survive into the committed recipe.
6. **Thumbnails.** Local photos render from the dropped folder. Scroll the full list top to
   bottom and back: images must not go blank on the way back up.
7. Scroll performance over ~317 rows should be smooth. If it is not, that is the
   `content-visibility` decision failing and worth reporting.

### 5. Commit

1. Commit and watch it chunk (25 at a time) with per-chunk progress.
2. **Try to reload mid-commit.** The browser should warn you. Reload anyway and confirm
   nothing is lost or double-written — go back to the box and count.
3. Force a failure if you can (stop the API process for a moment). The failed chunk should be
   retryable and the retry must not duplicate what already landed.
4. **Nothing may publish.** Check that every imported recipe is private and none appeared on
   your PDS. This is the single most important check on the page.

### 6. After

1. The done screen should account for every one of the 341: imported, linked, skipped,
   failed — and the numbers should add up to 341.
2. Go back to the recipes list and confirm the count moved by exactly the number imported.
3. Open three or four imported recipes and read them:
   - **instructions are separate steps**, not one paragraph;
   - tags came through as separate tags, not one comma-joined blob;
   - attribution matches what you chose for that source group;
   - a recipe that had a remote image has one.
4. **Run the import a second time with the same folder.** Everything should now come back as
   already-in-box. Committing again must not create a second copy of anything.

### 7. Worth a look if you have time

- The flow with VoiceOver on, particularly whether progress and count changes are announced
  without being overwhelming.
- The flow with "Reduce motion" enabled — nothing should animate.
- A phone or narrow window. The review screen is desktop-only today; what it does at 400px
  wide is unknown and is the next thing to design.
