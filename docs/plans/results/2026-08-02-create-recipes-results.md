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

---

# Create Recipes — build log (Phase B: server-side URL scrape)

Implementer: Claude (Opus 4.8), session 2026-08-03 (continued). Scope: **Phase B**
(server scrape, extraction, rate limit, SSRF, dedupe-adjacent import flow).
Verified end-to-end in the running app.

## Architecture (per user direction, looking ahead to a worker + per-site adapters)

The scraper is split so the extraction is a **pure, swappable module** and the
server fn is thin orchestration a future job-worker can replace without touching
the parser:

- **`packages/recipe-extract/`** — NEW pure package (`@buttery/recipe-extract`),
  no network / no DB / no framework. `extractRecipe({ html, url })` →
  lexicon-shaped `ExtractedRecipe` + hero image URL + soft warnings + which path
  produced it. Pipeline (highest confidence first): **per-host adapter →
  JSON-LD → microdata → coarse heuristics**, merged field-by-field.
  - `src/sites/index.ts` — **per-host extractor registry** (empty today; the
    `recipe_import_attempt` failure log tells us which hosts earn an adapter).
    Documented "how to add a site adapter".
  - `src/parse/{jsonld,microdata,heuristics}.ts`, `src/normalize/{text,duration,
diet}.ts`. Uses `node-html-parser` (isomorphic → Phase C browser bundle).
  - Vocab (cuisine/category/method) is emitted as RAW strings (`vocab`) for the
    web app to map via `recipe-vocab` — the package stays free of vocab drift.
    Diet is the exception (schema.org RestrictedDiet is a fixed URL set → mapped
    to tokens in-package). 4 unit tests (`extract.test.ts`) pass.
- **`services/web/src/lib/net/safe-fetch.ts`** — NEW SSRF-hardened fetch. http(s)
  only; DNS-resolves every hop and rejects private/loopback/link-local/CGNAT/
  multicast/reserved (v4 + v6, incl. v4-mapped) — blocks `169.254.169.254` &
  internal hosts; MANUAL redirect following (re-validates each hop); timeout +
  streamed size cap. `safeFetch` (text) + `safeFetchBytes` (binary, for the hero
  image). **Known residual:** DNS-rebinding TOCTOU window (documented; pinned
  connect is the hardening follow-up). `handle-resolve.ts` should adopt this.
- **`services/web/src/lib/net/recipe-page.ts`** — NEW DB-backed raw-HTML cache
  wrapping `safeFetch` (user request). `fetchRecipePage(url)`: normalize →
  `recipe_fetch_cache` lookup (24h TTL) → hit reuse / miss fetch+store. Lets an
  improved extractor / new site adapter RE-PARSE cached pages without recrawling.
- **`services/web/src/server/recipe-scrape.ts`** — NEW. `scrapeRecipe({url})`:
  Redis rate-limit → cached SSRF fetch → extract → **log the attempt (with the
  parsed prefill)** → return an opaque **import id**. `getImportPrefill({id})`
  returns the cached prefill (caller-scoped). No payload in the URL.

## Key decisions & deviations

1. **Prefill handoff = server-cached, fetched by id (NOT a URL fragment).** Per
   user direction mid-build: the parsed prefill is cached on the
   `recipe_import_attempt` row (`parsed` jsonb) and the client gets the row `id`
   as `?import=<id>`; the form calls `getImportPrefill` to load it. The earlier
   `#import=` base64-in-fragment approach was **removed entirely**. Phase C
   (bookmarklet) will use the SAME mechanism: extract on the hostile page → POST
   the result to the server → get an id → open `?import=<id>` (that POST endpoint
   is the one net-new piece Phase C still needs; not built yet).
2. **Attempt tracking (user request).** NEW `recipe_import_attempt` table logs
   EVERY attempt (success/rate_limited/blocked/fetch_failed/parse_empty/error)
   with host, extractor, http_status, duration_ms, error, and the cached parse.
   Powers failure analysis + per-site-adapter prioritization + the import-id
   handoff. Append-only, no FK (an attempt may never become a recipe).
3. **Raw-HTML cache (user request).** NEW `recipe_fetch_cache` (url PK, host,
   body, byte_size, fetched_at). Separate from the attempt log (that's the audit
   trail; this holds the heavy body only for successful fetches).
4. **Partial extraction → still opens the form.** If we reach the page but can't
   pull a body, the form still prefills whatever we got (title/image) with
   attribution locked. The "That page wouldn't open up" failure dialog is
   reserved for actual fetch failures (SSRF-blocked / network / 4xx-5xx).
5. **Imported hero image.** The form shows the hero by URL (not-yet-fetched) and
   `saveRecipe` stores it as a `recipe_pending_image.source_url` pointer.
   Publish-time fetch+upload (`safeFetchBytes` → `uploadBlob`) is implemented but
   **UNVERIFIED** — same gate as Phase A: the atproto-publish kill switch is off
   in dev, so no real publish ran.
6. **Redis.** NEW `services/web/src/lib/redis.ts` (lazy ioredis singleton). Redis
   provisioned on Railway (prod env) + a public TCP proxy for local dev; `.railway/
railway.ts` declares the service + `REDIS_URL` ref; local `.env` points at the
   proxy. Rate limit: `SET scrape:{did} NX PX 60000`. **Fails OPEN** if Redis is
   down (abuse mitigation, not a correctness gate). On hit: GENERIC message only —
   the window/retry-after is NEVER revealed to the client.

## Files

**New:** `packages/recipe-extract/**` (package + parsers + normalizers + sites
registry + tests), `services/web/src/lib/net/safe-fetch.ts`,
`services/web/src/lib/net/recipe-page.ts`, `services/web/src/lib/redis.ts`,
`services/web/src/lib/import-payload.ts` (shared `ImportPrefill` type),
`services/web/src/server/recipe-scrape.ts`,
`services/web/src/components/recipes/create/FetchingDialog.tsx`, migrations
`1785800000000_create_recipe_import_attempt`, `1785900000000_create_recipe_fetch_cache`,
`1786000000000_add_import_attempt_parsed`.

**Modified:** `.railway/railway.ts` (redis service + `REDIS_URL`),
`services/web/package.json` (+ioredis, +@buttery/recipe-extract),
`services/web/.env` (REDIS_URL via proxy), `lib/recipe-vocab.ts` (+`slugForLabel`),
`server/recipes-write.ts` (`imageSourceUrl` → pending `source_url`; publish-time
fetch), `components/recipes/create/RecipeForm.tsx` (fetch-by-id prefill, ISO→min,
token/label→slug mapping, URL-hero image), `components/recipes/create/AddRecipeChooser.tsx`
(scrape flow + Fetching/failure dialogs), `routes/household.recipes.new.tsx`
(`?import=<id>`).

## Verification (E2E, in the real app, signed in as The Frushineaus)

Sample URLs (user-provided): midwexican Instant Pot Spanish Rice,
indianhealthyrecipes chana dal.

- ✅ **Extractor** validated against both real pages (unit + live): full name,
  ingredients (27 / 9), steps (15 / 9), ISO times, yield, hero image, keywords,
  cuisine, nutrition — all via `jsonld`.
- ✅ **Import → prefill:** chooser → Import from a URL → Fetch → navigates to
  `?import=<id>` → form fully prefilled ("Check the import", Rows mode, hero image
  shown by URL, **attribution Locked** to the source). Console clean.
- ✅ **Attempt log:** `recipe_import_attempt` rows for both successes (jsonld, 200,
  parse cached) — the `id` matches the URL's import id.
- ✅ **Raw cache:** `recipe_fetch_cache` stored the 1.1 MB HTML body.
- ✅ **Import → Save privately:** draft written `origin=local, visibility=draft,
uri null`, 27 ingredients + 15 steps + **website attribution locked to the URL**
  - `recipe_pending_image.source_url` set. Detail view rendered; imported step
    times were even picked up by the cook-mode timer extractor.
- ✅ **Rate limit:** a 2nd import within 60s → "One at a time / You're going a
  little fast…" dialog with **NO window/countdown revealed**; logged as
  `rate_limited` (no parse, 16ms).
- ✅ **SSRF (unit):** `169.254.169.254`, `localhost`, `10/172.16/192.168`, `::1`,
  `fe80::` all rejected; public IPs allowed. (Not re-tested via UI — redundant.)

**Not run (blocked by design, same as Phase A):** real atproto **publish** →
so the publish-time **hero-image fetch+upload** (source_url → `uploadBlob`) and
the **import dedupe** against a public record remain UNVERIFIED (dedupe needs a
published record to collide with). Kill switch off in dev.

**Deferred to Phase C:** bookmarklet loader/install + the server POST endpoint
that accepts client-side extraction and returns an import id (reuses this exact
prefill-by-id mechanism).

All typecheck clean (`pnpm typecheck`); `recipe-extract` tests pass.
