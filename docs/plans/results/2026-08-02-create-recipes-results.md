# Create Recipes — build log (Phase A)

Implementer: Claude (Opus 4.8), session 2026-08-03. Plan:
`docs/plans/2026-08-02-create-recipes.md`. Scope: **Phase A** only (manual entry
end-to-end: form, save draft, publish, publish-later, preview, chooser, draft
lock, cron anti-dupe).

## Status

Phase A implemented; typecheck clean (`pnpm typecheck`), migration applied, DB
types regenerated. End-to-end browser verification: see "Verification" below.

## Infrastructure (done first, so the dev server only restarts once)

- **Railway object-storage bucket** `buttery-uploads` (id
  `a3bcce96-2cd9-48a7-8690-9a3bb66d7e98`) provisioned in the `production`
  environment. S3-compatible, endpoint `https://t3.storageapi.dev`,
  virtual-hosted style.
  - **Region: `sjc` (US-West).** ⚠️ User asked to consider `iad` (US-East).
    Railway buckets **cannot change region after creation**; the bucket is empty,
    so recreating in `iad` later is cheap. **Deferred** per user ("deal with that
    later"). To redo: delete bucket, `create_bucket(region:"iad")`, re-read the
    `BLOB_S3_*` reference values, update `services/web/.env` + redeploy.
  - `BLOB_S3_*` reference variables set on the `buttery` service (resolve the
    bucket's `ENDPOINT`/`REGION`/`BUCKET`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`) and
    declared in `.railway/railway.ts` (`bucket()` + `ref()`), plus mirrored into
    local `services/web/.env` for dev.
- Dep: `@aws-sdk/client-s3` added to `services/web`.
- `services/web/src/lib/blob-storage.ts` — lazy S3 client (`putBlob`/`getBlob`/
  `deleteBlob`), the single util for all Buttery-owned uploads.

## Key decisions & deviations

1. **Identity / rkey (the big one).** The whole codebase is built on the
   invariant **`recipe.id === rkey`** (both ULIDs) — migration comment, cron
   `render.ts` (`id: row.rkey`, `RECONCILE_LOCAL_SQL where id = rkey`), and
   provenance deep-links all assume it. The lexicon declares `key: "tid"`, which
   conflicts. **Decision: publish with an explicit `rkey = recipe.id` (our ULID)**
   via `client.create(recipe, values, { rkey })`. This preserves the invariant and
   means **zero cron changes** are needed — the existing `RECONCILE_LOCAL_SQL`
   path already reconciles a locally-published row by id. Trade-off: if the PDS
   rejects a ULID rkey for a `key:tid` collection, publish fails loudly (a thrown
   error, draft preserved) — a safe, verifiable failure mode.
   **Contingency if the PDS rejects it:** let the PDS mint a TID, store it in
   `recipe.rkey` separately, and add a small `(did,rkey)` reconcile lookup at the
   top of `renderRecipe` (before the id-based sync upsert) so the cron adopts the
   existing local row instead of inserting a duplicate `origin='sync'` row.
   _(Verify against the real PDS in step 3/5 below.)_

2. **Cron anti-dupe seed.** On publish, `saveRecipe`/`publishRecipe` also seed
   `atproto_collection_recipe` (raw, `(did,rkey)`) + `atproto_repo` so the next
   hourly sweep is a true no-op (same rev). Combined with (1), the sweep reconciles
   onto our row and never creates a second rendered copy.

3. **Form library.** Plan §A1 lists `@tanstack/react-form`; plan §A5 also cites
   `households.index.tsx CreateInviteForm` (plain `useState`) as the pattern to
   reuse. **Chose plain controlled `useState`** to match the actual repo
   convention and avoid an unfamiliar dependency. `@tanstack/react-form` NOT added.

4. **`RecipeView` refactor (§A6).** Built `RecipeView` as a **new** presentational
   component (record-shaped props, no fetches) used by the **Preview** dialog. The
   existing `DetailPane` was **augmented** (draft lock + Publish confirm dialog)
   rather than fully gutted into `RecipeView`. Rationale: `DetailPane` carries cook
   mode, timers, scaling, notes, favorite, remove — a full teardown while
   unattended risked regressions for marginal benefit. Both surfaces meet the
   acceptance checks (Preview renders via `RecipeView`; detail has the clickable
   lock → Publish). Full unification of `DetailPane`↔`RecipeView` left as
   follow-up.

5. **URL import in the chooser (Phase A).** "Import from a URL" has no scraper yet
   (Phase B). On Fetch it navigates to the form with `?source=<url>` → **import
   mode with Website attribution LOCKED** to the URL, fields empty for manual fill
   (this is exactly Phase B's scrape-failure fallback). Exercises the
   server-side sourceUrl attribution lock in Phase A. Bookmarklet option shown but
   disabled ("soon", Phase C).

6. **Vocab.** `lib/recipe-vocab.ts` (client-safe) mirrors the migration seed
   exactly, so form selects offer only known slugs and a local recipe's rendered
   `recipe.*` columns match what the cron would derive. Record carries the NSID
   token; rendered columns carry the slug.

7. **Nutrition / diet.** Lexicon `nutrition` has only calories + fat/protein/carb
   (mockup's serving-size/fiber/sugar/sodium have no lexicon fields — omitted).
   Single diet select (not multi) in v1.

## Files

**New:** `lib/blob-storage.ts`, `lib/recipe-vocab.ts`, `lib/recipe-attribution.ts`,
`server/recipes-write.ts` (`saveRecipe`/`publishRecipe`), `server/recipe-context.ts`
(shared `activeContext`), `routes/household.recipes.new.tsx`,
`components/recipes/RecipeView.tsx`, `components/recipes/create/*`
(`AddRecipeChooser`, `RecipeForm`, `LineEditor`, `IngredientsEditor`,
`InstructionsEditor`, `AttributionCard`, `PreviewDialog`, `DuplicateDialog`),
migration `1785700000000_create_recipe_pending_image.ts`.

**Modified:** `lib/atproto/recipe-writes.ts` (rkey + rev on `createRecipe`,
`uploadRecipeImage`), `server/household-recipes.ts` (`unpublished` on row+detail),
`components/recipes/context.ts` (`openAddChooser`), `routes/household.recipes.tsx`
(chooser + hide-ledger-on-`/new`), `components/recipes/RecipeLedger.tsx`
(`onAdd` + draft lock marker), `components/recipes/DetailPane.tsx` (draft lock +
Publish dialog), `routes/household.recipes.index.tsx`, `.railway/railway.ts`,
`services/web/.env`, `services/web/package.json`.

## Verification

**Static (done):** `pnpm typecheck` clean across the project; migration
`1785700000000` applied to the dev DB; `pnpm db:codegen` regenerated
`recipe_pending_image`; `pnpm generate-routes` registered
`/household/recipes/new`; dev server serves with no Vite build error from the new
code (the one console error on `/login` is a pre-existing skeleton↔card hydration
mismatch, unrelated).

**E2E (done, in the real app, signed in as The Frushineaus):** verified via Chrome
at `127.0.0.1:3000`. Console clean throughout — the only errors are the
pre-existing `/login` skeleton↔card hydration mismatch.

- ✅ **Chooser modal** — "Add a recipe" with Import-from-URL / Enter-manually /
  Use-the-bookmarklet (SOON, disabled) + "Add an existing recipe".
- ✅ **Full-page form** at `/household/recipes/new`, ledger hidden, matches the
  mockup (basics / ingredients / instructions / accordion; Attribution +
  Where-it-lands rail).
- ✅ **(0)** Save draft + Save & publish disabled until attribution complete
  ("Saving unlocks once the attribution is complete").
- ✅ **(0b)** Rows mode + **soft warning**: "some butter" → "⚠ Couldn't read an
  amount — try '2 tbsp butter'." while "2 tbsp butter"/"1 cup flour" are clean;
  non-blocking (save stayed available).
- ✅ **Attribution** — type select reveals the union's required fields; Original
  reveals License; status Nothing→Fill the starred fields→**Complete**; completing
  it **enables** both Save buttons.
- ✅ **Save draft** (non-publish) → recipe saved `origin=local, visibility=draft,
uri null, rkey null`, auto-boxed into the household, children
  (ingredient/attribution `original/cc_by`/search) written (DB-verified), navigated
  to detail.
- ✅ **Draft lock** — lock icon on the ledger row; detail shows the clickable
  "🔒 Private draft · Publish" pill.
- ✅ **Publish confirmation dialog** appears from both the form's Save & publish
  and the detail lock ("Publish this recipe? … hard to undo").
- ✅ **Kill switch** — with publishing disabled, Save & publish saved a draft +
  toast "Publishing is turned off right now — saved as a draft."; the detail-lock
  Publish path was likewise blocked and the row **stayed** `draft`/no-`uri`
  (DB-verified). No PDS write occurred.
- ✅ **Preview** — `RecipeView` renders the draft from in-memory form state
  (title, source, bulleted ingredients) with the 🔒 Draft badge and no action
  buttons.

**Not run (blocked by design):** the actual atproto **publish** (real
`uri`/`cid`/`rkey`, PDS record), **image blob upload on publish**, and the **cron
anti-dupe sweep** were NOT exercised — the user directed "do not publish to atproto"
during testing, and the new kill switch enforces that server-side (no
`POSTHOG_PROJECT_TOKEN` in dev → fail-closed). Consequently the **rkey=ULID vs
`key:"tid"` PDS-acceptance question (decision 1) remains UNVERIFIED** — confirm it
in a controlled environment with publishing enabled before relying on the
zero-cron-change path; the TID+cron-reconcile contingency is ready if the PDS
rejects a ULID rkey.

## Addendum — atproto publish kill switch (added at user request during testing)

A PostHog feature flag now gates all atproto publishing.

- `lib/posthog-server.ts`: `ATPROTO_PUBLISH_FLAG = "atproto-publishing-enabled"` +
  `isAtprotoPublishEnabled(did)`. **Fail-closed:** publishing is allowed ONLY when
  the flag explicitly serves `true`. Env override `ATPROTO_PUBLISH_ENABLED=true|false`
  wins (dev/emergency escape hatch). No PostHog client (local dev) or any flag
  error → BLOCKED.
- `server/recipes-write.ts`: both `saveRecipe` (publish path) and `publishRecipe`
  check the gate before any PDS write and return a new `{ status: "publish_disabled",
recipeId }` result; any draft is still saved.
- UI: `RecipeForm` and `DetailPane` surface `publish_disabled` as a toast
  ("Publishing is turned off right now…") and keep the recipe a draft.
- **To enable publishing:** create the `atproto-publishing-enabled` flag in PostHog
  and serve `true` to the target user(s), or set `ATPROTO_PUBLISH_ENABLED=true` in
  the environment (a dev-server restart picks up the env var).

## Follow-up changes (post-verification, at user request)

1. **Bucket region → iad (US-East).** Deleted the sjc bucket via the Railway CLI
   (`railway bucket delete`) and recreated `buttery-uploads` in `iad`
   (S3 name `buttery-uploads-ggwykzan0`). Re-pointed the prod `BLOB_S3_*`
   reference vars (they resolve by bucket name), updated `.railway/railway.ts`
   region to `iad`, and refreshed `services/web/.env` with the new creds.
   ⚠️ `.env` change needs a dev-server restart to take effect.
2. **Wired the `atproto-publishing-enabled` flag in PostHog** (project 538428,
   flag id 796889): active, `evaluation_runtime: server`, **0% rollout** so it
   serves `false` (publishing stays OFF). Raise the rollout or add a person
   condition (keyed on DID) to enable.
3. **Recipe ledger search bar cleanup** (`RecipeLedger.tsx`): removed the keyword
   **tag-filter chips** (+ `topTags`/`LedgerFilters.tag`); added a **`+` icon** to
   the Add button; added a **"My recipes"** toggle that filters to the household's
   private/unpublished drafts (`row.unpublished`). `LedgerFilters` is now
   `{ q, sort, mine }`.
4. **Paste bug fix** (`LineEditor.tsx`): pasting a text block with blank
   (paragraph-spacing) lines no longer creates empty ingredient/step rows. The
   paste handler now trims each line and drops blanks
   (`.map(trim).filter(Boolean)`), and switching to Rows/Steps compacts existing
   blanks (`toRows`). Verified the handler logic deterministically (6 non-blank
   lines in → 6 rows, zero empty). NOTE: the live dev server was serving a stale
   HMR bundle of `LineEditor` during verification — a dev-server restart is needed
   to see this fix (and the new bucket creds) live.

All typecheck clean (`pnpm typecheck`).
