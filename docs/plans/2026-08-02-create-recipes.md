# Plan: Create Recipes (import + manual entry, attribution-enforced)

> **Implementers:** write your build log — decisions, deviations, and results —
> to `docs/plans/results/2026-08-02-create-recipes-results.md` as you go. This is
> an acceptance criterion, not optional.

> **Get the design handoff FIRST.** Before writing any UI, request the
> `CreateRecipes` design handoff from the `/design` project
> (`291c2ffb-d031-4fa8-a2af-44875fc00615`, mockup `CreateRecipes-standalone.html`)
> and build to it. This plan encodes the mockup's structure + copy, but the
> handoff is the source of truth for exact spacing, tokens, and component specs
> (buttery uses the `buttery-design-system` + `shadcn`/Base UI conventions). Do
> not start the form UI without it.

## Context

Buttery today can only **link** existing public recipes into a household box
(`GlobalRecipePicker` → `addRecipeToHousehold`). There is no way to _author_ a
recipe. The atproto write path exists but is completely unwired
(`createRecipe()` in `services/web/src/lib/atproto/recipe-writes.ts` has zero
callers), and the `recipe` table already supports local drafts
(`origin='local'`, `visibility='draft'|'private'|'public'`).

This feature adds recipe creation with three entry paths that all converge on
one lexicon-shaped form:

1. **URL import** (primary) — server-side scrape of a recipe URL.
2. **Bookmarklet** (fallback for anti-scraping sites) — a tiny loader that pulls
   an extraction script from our domain, runs it on the hostile page, then opens
   an authenticated Buttery tab prefilled with the result.
3. **Manual entry** — the same form, empty.

**Non-negotiable requirement: attribution.** Every recipe must carry a valid
`exchange.recipe` attribution. The lexicon marks `attribution` _optional_;
Buttery enforces it at the form and server layers. URL-imported recipes get
attribution **locked** to the source URL — the user cannot alter it.

Recipes default to a private household **draft**; publishing to atproto (public)
is a deliberate, separate action available both at create time and later.

### Key decisions (confirmed with user)

- **UI shape (per mockup):** the entry **chooser is a modal** ("Add a recipe"),
  but the recipe **form itself is a full page** at `/household/recipes/new` with a
  two-column layout (main fields left, Attribution + "Where it lands" cards in a
  right rail). Fetching / duplicate / scrape-failure / bookmarklet-install /
  Preview are all modal dialogs over their own scrim.
- **Single entry point (per mockup):** the "Add a recipe" chooser modal is THE
  add entry point. It offers _Import from a URL_ / _Enter it manually_ / _Use the
  bookmarklet_ **and** an **"Add an existing recipe"** button. The create options
  navigate to the full-page form; "Add an existing recipe" opens today's
  `GlobalRecipePicker` as one branch (the picker is demoted from primary surface
  to a branch of the chooser).
- **Bookmarklet transport (updated post-Phase-B, see §C):** the bookmarklet does
  **no parsing** — it finds JSON-LD and sends that, else sends the page's raw HTML,
  and the **server runs the same `recipe-extract` subsystem**. Payload reaches the
  server through an **authenticated Buttery tab via `postMessage`** (the hostile
  page can't POST with the session cookie); the tab calls `submitImport` and lands
  on the form via the **Phase B import id** (`?import=<id>`). No CORS, no
  cross-origin POST, no bookmarklet token, no `#import=` fragment, no browser
  extractor bundle.
- **Images:** single image in v1 (imported hero or one manual upload); uploaded
  to atproto as a blob **on publish**. Multi-image deferred.
- **Delivery:** phased — A (manual form + save/publish core), B (server scrape),
  C (bookmarklet). Each phase ships independently.
- **Household link:** creating a recipe auto-boxes it into the creator's active
  household (any visibility), immediately visible/private to the household.
- **Publish timing:** both — "Save & publish" on the create form, and a
  "Publish" action later on a draft's detail view. **Publishing always requires a
  confirmation dialog** (public + hard to reverse). _(Note: the mockup does not
  draw this confirm dialog; add it anyway per explicit user decision.)_
- **Dedupe:** block importing a URL that matches an existing **public (atproto)**
  record only (never dedupe against drafts). The duplicate dialog ("Someone
  already published this one") offers **Open the recipe** / add the existing one
  to the box — not a silent redirect.
- **Rate limiting:** **scraping only**, 1 per 60s per account, **Redis-backed**
  (new Redis service; also seeds a general cache). Save/publish not rate-limited.
  **On hit, show a generic "slow down" message only — never reveal the limit
  window or a countdown/retry-after** (don't hand an abuser the timing).
- **Cron reconciliation on publish:** when we publish, we must seed the
  `atproto_*` sync tables so the next hourly cron sweep treats _our_ record as
  already-fetched and does **not** create a duplicate rendered row. (Cron
  `services/atproto-cron-sync` enumerates DIDs → lists repo records → upserts raw
  → renders into `recipe`; a freshly published local record is otherwise a
  brand-new record it has never seen.)
- **Scrape failure UX:** offer bookmarklet + manual (URL prefilled) + "contact
  support" (fires a PostHog support message with the failing URL).
- **Attribution rule:** must choose 1 of 6 types + fill its required fields;
  `Original` (needs a license) is the legitimate self-authored escape hatch.
- **Ingredients/instructions:** flat string arrays (exact lexicon shape).
- **Transport = lexicon record:** client↔server payload is the
  `exchange.recipe.recipe` record shape (validated by the generated lex schema)
  wrapped in a thin Buttery envelope.

---

## Canonical schema & transport

The wire contract between form, server fn, and atproto is the generated lexicon
type. Reuse — do not redefine:

- Record type + validator: `@buttery/lexicons/exchange/recipe/recipe`
  (`Main`, default export `recipe`). The generated schema exposes
  `recipe.safeValidate(x)` / `recipe.safeParse(x)` (`@atproto/lex-schema`
  `Schema` base) → `{ success, value | reason }`. This is the server's
  authoritative validation gate.
- Existing derived type: `NewRecipe` in `recipe-writes.ts:13`
  (`Omit<Main,"$type"|"createdAt"|"updatedAt"> & Partial<…timestamps>`).
- Attribution unions live in `exchange.recipe.defs` (`attributionOriginal`,
  `attributionPerson`, `attributionPublication`, `attributionWebsite`,
  `attributionShow`, `attributionProduct`).

**Envelope** (Buttery-only fields alongside the record): `visibility`
(`'draft'|'private'`), `publish: boolean`, `sourceUrl?: string` (locks Website
attribution + drives dedupe), and image payload (see Images). The server
**never trusts client attribution for imported recipes** — when `sourceUrl` is
present it re-derives `attributionWebsite` server-side.

---

## Phase A — Form, save, publish core (manual entry works end-to-end)

### A1. Dependencies & DB

- Add `@tanstack/react-form` to `services/web/package.json`.
- New migration in `services/web/src/db/migrations/`, scaffolded with
  `pnpm --filter @buttery/web db:migrate:new <snake_case_name>` — never hand-name
  the file; the CLI stamps the epoch-ms prefix from `Date.now()`. Then fill in the
  generated `up`/`down` following the existing style (see memory: Kysely conventions):
  - Allow local recipes into the box: add a server path (or relax the
    `visibility='public'` guard) so `household_recipe` accepts an `origin='local'`
    recipe. Keep the public-only rule on the _link-existing_ flow
    (`addRecipeToHousehold`, `household-recipes.ts:338`) untouched.
  - Index for dedupe: index `recipe_attribution` on normalized website URL
    (the flattened `url` column) filtered to public recipes, so
    "does a public record already cite this URL?" is a cheap lookup.
  - Pending-image storage for **drafts** (unpublished, so no atproto blob yet):
    store the bytes in **Railway blob storage** (S3-compatible API — provision a
    bucket via Railway, use an S3 client e.g. `@aws-sdk/client-s3` with the
    Railway-provided endpoint/credentials as env vars). DB keeps only a pointer
    row (`recipe_pending_image`: `recipe_id` FK, `object_key`, `mime`, `alt`, or a
    `source_url` for not-yet-fetched imported heroes). On publish the object is
    read from the bucket, uploaded to atproto as a blob, then the object + row are
    cleared. **General rule: all Buttery-side file uploads use Railway blob
    storage (S3 API), not Postgres bytea.**

### A2. Server functions (`services/web/src/server/recipes-write.ts`, new)

Follow the authenticated-mutation prologue from `household-recipes.ts:331-336`
(`activeContext()` → `did` + `householdId`, then `assertMember`). Dynamically
`import("#/lib/db")` inside handlers (server-only pg out of client bundle).

- `saveRecipe({ record, visibility, publish, sourceUrl, image })`:
  1. `activeContext()` + `assertMember`.
  2. **Attribution enforcement:** if `sourceUrl` present → overwrite
     `record.attribution` with a server-built `attributionWebsite`
     `{ name: <site/domain>, url: sourceUrl }`. Else require a valid attribution
     union already present. Reject (typed error) if absent/invalid.
  3. **Lexicon validation:** `recipe.safeValidate({ $type, …record, createdAt,
updatedAt })`; on failure return field-path issues to the client.
  4. **Dedupe (publish only):** if `publish` and `sourceUrl` matches an existing
     **public** record's website attribution → return a `DUPLICATE` result with
     the existing recipe id (client redirects; nothing written).
  5. Mint a ULID `recipe.id` (stable PK, never changes). Insert `recipe`
     (`origin='local'`, chosen `visibility`) + children (`recipe_ingredient`,
     `recipe_instruction`, `recipe_keyword`, `recipe_attribution`,
     `recipe_search` tsvector). Mirror the cron's normalization in
     `services/atproto-cron-sync/src/render.ts` so local + synced rows render
     identically.
  6. Auto-box: insert `household_recipe(householdId, recipe.id)`.
  7. If `publish`: call `createRecipe(did, record)`
     (`recipe-writes.ts:34`); if an image exists, upload it first (A3) and set
     `record.embed.images[0]`. Store returned `{ uri, cid }` + `rkey`/`did`/`rev`
     - `visibility='public'` + `published_at` on the row. **`recipe.id` stays the
       local ULID; the atproto tid `rkey` is stored separately** (do not conflate).
  8. **Reconcile sync tables (anti-dupe):** immediately after a successful PDS
     write, seed the cron's sync bookkeeping so the next sweep is a no-op for this
     record:
     - Insert the raw record into `atproto_collection_recipe` with the returned
       `uri`/`cid`/`rev` (matches what cron would upsert → same rev = no-op).
     - Advance/record the repo cursor/rev bookkeeping (`atproto_repo`) as needed
       so the record is inside the "already synced" range.
     - **Key alignment (must resolve in impl):** cron matches records by
       `did`+`rkey`, but a local row's `recipe.id` is a ULID, not the tid `rkey`.
       Ensure the published local row is discoverable on `did`+`rkey` so cron
       upserts **onto our existing row** instead of inserting a second
       (`origin='sync'`) copy — either by having cron's render match on `did+rkey`
       (recipe stores `rkey`/`did`/`uri` after publish) or by an explicit
       `did+rkey` uniqueness/lookup. Verify the exact cron dedupe key in
       `services/atproto-cron-sync/src/sweep.ts` + `render.ts` before finalizing.
     - **Cron-side counterpart (may be required):** the sync engine may also need
       to handle the inverse — encountering a record with **no**
       `atproto_collection_recipe` raw row but a **matching rendered `recipe` row**
       (our locally-published record) and **auto-link** them (backfill the raw
       row / adopt the existing rendered row by `did+rkey`) instead of inserting a
       duplicate. This makes reconciliation robust even if the publish-time seed
       (above) is missed or partial. Scope this change in
       `services/atproto-cron-sync/src/sweep.ts` + `render.ts`.
- `publishRecipe({ recipeId })`: the "publish later" action — loads a draft the
  caller owns, runs steps 3–4 + 7 + 8, flips visibility to public.

### A3. Image upload (net-new)

- Add `uploadRecipeImage(did, bytes, mime)` in `recipe-writes.ts` using the
  authenticated lex `Client` from `getUserRecipeClient(did)` →
  `com.atproto.repo.uploadBlob`. Validate `image/*` + ≤1MB (lexicon `maxSize`).
  Returns the blob ref for `record.embed.images[0].image`.
- Draft images live in a **Railway S3 bucket** (pointer row in
  `recipe_pending_image`); publish reads the object → `uploadBlob` → clears the
  object + row. Add `lib/blob-storage.ts` (S3 client bound to the Railway
  bucket endpoint/creds) as the single upload/download util.

### A4. Entry chooser modal + navigation (Base UI dialogs, `#/components/ui/dialog`)

Per the mockup, a single **`AddRecipeChooser`** modal ("Add a recipe" — _"Bring
one in from the web, or write it out yourself."_) is the add entry point. Radio
options (exact copy):

- **Import from a URL** — "Paste a recipe link and Buttery reads the page." →
  reveals a URL input + **Fetch** button. On Fetch: open the **Fetching…** dialog
  (Phase B), then on success navigate to the form prefilled.
- **Enter it manually** — "The empty form. You pick the attribution." → navigate
  to the empty form.
- **Use the bookmarklet** — "For sites that won't let Buttery read them." → open
  the bookmarklet-install dialog (Phase C).
- Footer: **Cancel** and **"Add an existing recipe"** → opens today's
  `GlobalRecipePicker`.

Wiring: replace the current direct-to-`GlobalRecipePicker` triggers with
`AddRecipeChooser`. Extend `RecipesViewContext`
(`components/recipes/context.ts`) with `openAddChooser()`; the existing "Add"
buttons (`RecipeLedger.tsx:111,207`, `household.recipes.index.tsx:25`) call it.
The chooser opens the picker as a branch (`openPicker()` stays). Create options
`navigate` to the full-page form route (A5) rather than opening another modal.

### A5. RecipeForm — full page at `routes/household.recipes.new.tsx` (TanStack Form)

Full-page, two-column layout (matches mockup): main column = content cards, right
rail = Attribution + "Where it lands" cards. Page header: back-link "Back to the
recipe box", a mode badge ("Entered by hand" / "Imported from <host>"), title
"A new recipe" / "Check the import". Imported forms show the top callout **"Say
who this came from"** explaining attribution permanence.

**Content cards (main column):**

- **The basics:** `name` (Name), `text` (Description, help "Shows under the title
  on the recipe page."), and **Photo** — drop-zone / "Choose a file"; help "One
  photo, up to 1 MB. It's held with the draft and uploaded to your atproto repo
  when you publish." Imports show "✓ Photo found on the page" + **Replace** /
  **Remove**.
- **Ingredients:** **dual-mode editor** with a **"Paste a list" ↔ "Rows"** toggle
  - a live count ("N ingredients").
  * _Paste_ = one `<textarea>`, one ingredient per line ("however you'd write it
    on a card"). Manual entry defaults here.
  * _Rows_ = per-line inputs with **drag-reorder handles**, per-row delete, and
    "+ Add an ingredient". Imports default here.
  * Both modes serialize to the flat `ingredients: string[]` lexicon array.
  * **Auto-flip on paste:** once the user pastes into _Paste_ mode, split the
    lines and **switch to _Rows_ mode immediately** so per-row parse warnings
    (below) are visible right away and the user can fix issues inline.
- **Instructions:** same dual-mode pattern with a **"Paste steps" ↔ "Steps"**
  toggle. _Steps_ mode shows **numbered** rows (drag-reorder, delete). Serializes
  to flat `instructions: string[]`. Help: "One step per line. Blank lines are
  ignored." Same **auto-flip on paste** → _Steps_ mode as ingredients.
- **Soft parse warnings (non-blocking, distinct from validation errors):** the
  editors run Buttery's extractor functions per row and surface a **warning**
  (⚠︎ hint, never blocks save) when good structured data can't be pulled out —
  this _guides_ the user toward cleaner input, it does not reject it.
  - _Ingredients_ — run the **amount + unit extractor** on each row; if it can't
    confidently find a quantity/unit (e.g. "some butter", "a handful"), show an
    inline hint like "Couldn't read an amount — try '2 tbsp butter'." This feeds
    later shopping-list quantity math, so nudging structured input early matters.
  - _Instructions_ — run the **timer/duration extractor** on each step; if a step
    reads like it has a time but none parses, hint that adding an explicit
    duration ("bake 25 min") powers cook-mode timers later
    (see memory: timers code structure).
  - Warnings are advisory only: the lexicon still stores the raw strings; the
    save/publish buttons are **not** gated on them (only attribution + lexicon
    validation gate saving). Reuse the extractors from `lib/timers` / the
    shopping-amount logic if they already exist; otherwise this plan introduces
    them as small shared parsers the editor and downstream features both call.
- **Optional collapsible sections** (accordion rows, collapsed by default, each
  with a summary line): **Times & yield** (`prepTime`/`cookTime`/`totalTime` ISO
  strings + `recipeYield`), **Cuisine, category, method & diet** (controlled
  vocab selects from `exchange.recipe.defs`: `recipeCuisine`/`recipeCategory`/
  `cookingMethod`/`suitableForDiet`; summary "helps the randomizer later"),
  **Keywords** (`keywords[]`), **Nutrition** (`nutrition`). Summaries reflect
  state ("Optional · nothing filled in" / "Imported · 15 min prep · makes 12").

**Right rail cards:**

- **Attribution** (badge **Required**). Manual: prompt "Where did this come
  from?" → a select **"Choose a source…"** with exactly: _Original — I wrote
  this_ / _A person_ / _A book or magazine_ / _A website_ / _A show or episode_ /
  _A product or package_. Selecting a type reveals its required fields (mirror
  each union's `required`: Website name+url, Publication title+author, Person
  name, Show title+network, Product brand+name, Original license). **Import**:
  badge **Locked**, renders the WEBSITE attribution read-only (site name + source
  URL external link) with copy "An imported recipe is credited to the page it
  came from, and that isn't editable — the source stays with the record." plus a
  **"Start over by hand"** link (drops the lock → switches to manual entry).
- **Where it lands:** copy "A private draft in **<household>**. Nothing leaves
  your account until you publish." Then the action buttons: **Preview**,
  **Save draft**, **Save & publish**, **Cancel**.

**Save gating (per mockup):** `Save draft` and `Save & publish` are **disabled
until attribution is complete**, with helper text "Saving unlocks once the
attribution is complete." (Imports satisfy this immediately via the locked
Website attribution.)

**Actions:**

- `[Save draft]` → `saveRecipe({ visibility:'draft', publish:false })`.
- `[Save & publish]` → **confirmation dialog first** ("This makes the recipe
  public on atproto and is hard to undo") → `saveRecipe({ publish:true })`.
  Reuse `services/web/src/components/ConfirmDialog.tsx`. Same confirm gates the
  detail lock-icon Publish path (A6) and `publishRecipe`.
- Validation: TanStack Form client-side; **server re-validates via
  `recipe.safeValidate`** and returns field-path issues. The form renders an
  error summary ("Three things need a look" linking to each field) + inline
  per-field errors — the mockup explicitly notes "Field errors come back from the
  lexicon validator on the server, so the message matches the record's own rules."
- On success → `router.invalidate()` + navigate to the new recipe (mirror
  `household.recipes.tsx:50-54` `onAdded`). On `DUPLICATE` → the duplicate dialog
  (B/dedupe), not a silent redirect.
- Reuse `#/components/ui/` primitives (`Field`, `Input`, `Select`, `Button`,
  `Spinner`) — multi-field pattern in `households.index.tsx` `CreateInviteForm`.
- **Preview button:** `[Preview]` opens the recipe **detail view in a dialog**
  ("Preview" title + **Draft** badge + "Back to editing" close), rendered
  full-width from the current unsaved form state. See A6 — Preview reuses the same
  `RecipeView` component as the real detail page, fed the in-memory lexicon record.

### A6. Recipe detail as a controlled "master" display component

Refactor the existing recipe reading pane
(`services/web/src/components/recipes/DetailPane.tsx`) into a **large, mostly
controlled/presentational** component — call it `RecipeView` — used in **two**
places:

1. The existing detail location (`household.recipes.$id.tsx` → the reading pane).
2. The **Preview modal** launched from `RecipeForm`, fed draft data.

Contract:

- **Input = the atproto record shape** (`exchange.recipe.recipe` `Main`, same
  type the form builds and the server validates) plus render-only extras
  (resolved image URLs, author/handle, household note, favorite state, etc.)
  passed as props. One prop shape serves both saved recipes and draft previews.
- **No internal API fetches / no data loading of its own.** All data arrives via
  props; the _callers_ fetch (detail route loader) or supply in-memory state
  (Preview). This is the key rule: `RecipeView` is presentational.
- **Actions are optional callbacks**, and each action's availability is
  configured by prop presence / enable flags — e.g. `onAddToShoppingList?`,
  `onPublish?`, `onFavorite?`, `onEditNote?`, `onStartCook?`. In Preview these
  are omitted/disabled (nothing is saved yet); on the real detail page they are
  wired to the existing server fns.
- **Image handling:** images are passed as **URLs** so the same component renders
  a published atproto blob (CDN URL via `blobImageUrl`, `lib/atproto/images.ts`)
  OR a draft's not-yet-uploaded image (a local `URL.createObjectURL(file)` or a
  signed Railway-bucket URL) with no branching inside the component.
- **Impl note:** audit what `DetailPane` does today — any fetching, mutations, or
  session/household reads must be **lifted out** into the detail route / a thin
  wrapper, leaving `RecipeView` pure. The lock-icon + Publish dialog (below) live
  on `RecipeView` too, gated by `onPublish?` presence (absent in Preview).

- **Publish-later + draft lock indicator:** unpublished recipes
  (`visibility` `'draft'|'private'`, i.e. no atproto `uri`) show a **lock icon**:
  - In the left **ledger rows** (`components/recipes/RecipeLedger.tsx`) as a small
    private/unpublished marker.
  - In the **recipe detail** (`components/recipes/DetailPane.tsx`) as a clickable
    lock. Clicking it opens a simple **Publish dialog** ("Make this public on
    atproto?") → confirm calls `publishRecipe({ recipeId })`. On success the row
    flips to `public` (gets `uri`/`cid`/`rkey`), the lock disappears, **and the
    `atproto_*` sync tables are reconciled** exactly as in `saveRecipe` step 8
    (anti-dupe). This dialog is the primary "publish later" entry point (replaces
    a plain button).

---

## Phase B — Server-side URL scrape

### B1. Redis + rate limit

- Add a Redis service (Railway, via `.railway/railway.ts`) + `ioredis` dep. New
  `services/web/src/lib/redis.ts` lazy singleton (mirror `lib/db.ts` shape).
- `scrapeRecipe({ url })` server fn: rate-limit key `scrape:{did}`, `SET NX PX
60000` → on hit return a generic `RATE_LIMITED` result. **Do not return or
  display the window / retry-after / countdown** — the UI shows only a generic
  "you're going too fast, slow down and try again shortly" message (don't leak
  the limit timing to a potential abuser).

### B2. Hardened fetch (SSRF) — net-new

- New `services/web/src/lib/net/safe-fetch.ts`: parse URL, require http(s),
  resolve DNS and **reject private/loopback/link-local/metadata IPs**, block
  redirects to private targets, timeout + size cap. Lift the retry/backoff
  client from `services/atproto-cron-sync/src/http.ts` for the transport.
  (Today `handle-resolve.ts:48` fetches user domains with **no** SSRF guard —
  this new util should become the standard for all user-URL fetches.)

### B3. Extraction parser — net-new, shared

- New `packages/recipe-extract/` (a standalone package so the same extractor is
  reusable — Phase C's bookmarklet ingest runs it server-side too, no browser
  bundle):
  - Parse `<script type="application/ld+json">` schema.org/Recipe (handle
    `@graph`, arrays, `HowToStep`/`HowToSection`, ISO-8601 durations).
    Reuse the diet-slug↔schema.org map from `recipes.$id.tsx:49-62` (both
    directions).
  - Microdata (`itemprop`) fallback; then coarse DOM heuristics.
  - Output the lexicon record shape (minus timestamps) + a hero image URL.
- `scrapeRecipe` = safe-fetch HTML → parse → return prefill payload with
  `sourceUrl` set (so the form locks Website attribution).

### B4. Failure UX (mockup frame "The site wouldn't cooperate")

- On scrape failure/empty result the Fetching dialog becomes **"That page
  wouldn't open up"** — "Some sites block anything that isn't a browser. The
  recipe is still gettable — here are the two ways in." Shows the URL, then:
  **[Try the bookmarklet]** (→ bookmarklet-install dialog) / **[Enter it
  manually]** (→ form with `sourceUrl` prefilled → **attribution stays locked to
  the URL**: "Either way the credit stays locked to that URL — the source doesn't
  get lost just because the page fought back.") / **"Tell Buttery about it"**
  (support link → fire a PostHog support message/event capturing the failing URL
  - user, confirm to the user) / Cancel.

---

## Phase C — Bookmarklet fallback

**Design update (post-Phase-B):** the bookmarklet does **no parsing of its own** —
it stays a tiny loader. On a recipe page it does the simplest possible thing:

> **Look for JSON-LD; if you find it, send that. Otherwise send the page's raw
> HTML.** Either way the **server runs the exact same `recipe-extract` subsystem**
> (§B3) on it — one extractor, one code path, no browser bundle to keep in sync.

Because the recipe page is a hostile third-party origin, the payload can't be
POSTed straight to `buttery.recipes` (the session cookie is `SameSite`, so a
cross-site POST would be unauthenticated). Transport therefore stays the
**Phase A decision**: open an **authenticated Buttery tab** and hand it the
payload via `postMessage`. The Buttery tab (same-origin, signed in) calls the
server, which extracts + caches the parse and returns an **import id**; the tab
then lands on the create form at `?import=<id>` — the **same import-id prefill
mechanism Phase B already ships** (no URL payload, no `#import=` fragment).

### C1. Loader script (served from our domain)

- Serve a standalone JS via a server route handler (bracket-escape pattern from
  `routes/oauth-client-metadata[.]json.ts`), e.g. `routes/bookmarklet[.]js.ts`,
  returning `Content-Type: application/javascript`. This lets the script embed the
  app origin.
- The `javascript:` snippet injects `<script src="https://buttery.recipes/bookmarklet.js">`.
  The loaded script:
  1. Collect the payload from the current page:
     - Read every `<script type="application/ld+json">` block. If any parses to
       (or contains, via `@graph`) a schema.org `Recipe`, the payload is
       `{ kind: "jsonld", data: <the ld+json text/objects>, url: location.href }`.
     - **Otherwise** the payload is `{ kind: "html", html: document.documentElement.outerHTML, url: location.href }`
       (size-capped; if it somehow exceeds the cap, still send — the server
       re-caps).
  2. `window.open("https://buttery.recipes/household/recipes/import-bridge")` (an
     authenticated same-origin bridge route, C3a). Handshake: the bridge posts a
     `ready` message to its opener; the bookmarklet replies with the payload via
     `postMessage` (targetOrigin pinned to `https://buttery.recipes`). The bridge
     validates `event.origin` is the recipe page it opened and ignores anything
     else.
- **No `packages/recipe-extract` browser bundle** — the browser only detects +
  ships raw JSON-LD or HTML; all mapping happens server-side.

### C2. Install dialog (mockup frame "Get the bookmarklet")

- The chooser's "Use the bookmarklet" option opens a **drag-to-bookmarks-bar**
  dialog: "Click and drag this to your bookmarks bar. It doesn't install and it
  isn't a link to click here — click and drag it onto your bookmarks bar." A
  draggable **"Save to Buttery"** button (the `javascript:` bookmarklet as its
  `href`), numbered steps ("Show your bookmarks bar", "Click and drag the button
  — don't just click it", "On a recipe page, click Save to Buttery — you stay
  signed in"), and a **Done** button.

### C3. Server ingest + bridge + prefill (reuses Phase B's import id)

- **`submitImport` server fn** (net-new, alongside `scrapeRecipe` in
  `server/recipe-scrape.ts`): `activeContext()` for auth, accepts
  `{ url, jsonld? , html? }`. Normalize to HTML for the shared extractor —
  wrap JSON-LD as `<script type="application/ld+json">…</script>` when `kind:jsonld`,
  else use the posted `html` — then run the **same `extractRecipe({ html, url })`**
  as Phase B, write a `recipe_import_attempt` row (source e.g. `bookmarklet`) with
  the cached parse, and return an **import id** (or a typed failure). Note: this
  path has **no server-side fetch**, so `safe-fetch` / the rate limiter / the
  `recipe_fetch_cache` don't apply — the bytes come from the user's own browser.
  (Optionally reuse the per-account Redis limit keyed `import:{did}` to bound abuse.)
- **`routes/household.recipes.import-bridge.tsx`** (net-new, authenticated): a
  minimal same-origin landing that performs the `postMessage` handshake (C1),
  calls `submitImport`, then `navigate`s to `/household/recipes/new?import=<id>`
  (or shows the failure UX on a typed failure). This is the tab the bookmarklet
  opens.
- **Prefill:** unchanged from Phase B — the create form loads the cached prefill
  by `?import=<id>` (`getImportPrefill`), locks Website attribution to the source
  URL, title "Check the import". No new form code.

---

## Files (representative)

**New**

- `services/web/src/server/recipes-write.ts` — `saveRecipe`, `publishRecipe`.
- `services/web/src/routes/household.recipes.new.tsx` — the **full-page** create
  form (A5); loads imported prefill by `?import=<id>` (Phase B + C).
- `services/web/src/routes/household.recipes.import-bridge.tsx` — authenticated
  `postMessage` bridge the bookmarklet opens (C3); calls `submitImport` → lands on
  the form at `?import=<id>`.
- `services/web/src/components/recipes/create/` — `AddRecipeChooser.tsx` (entry
  chooser modal), `RecipeForm.tsx`, `IngredientsEditor.tsx` /
  `InstructionsEditor.tsx` (dual-mode paste↔rows + soft parse warnings),
  `AttributionCard.tsx`, `PreviewDialog.tsx`, `BookmarkletInstallDialog.tsx`,
  `DuplicateDialog.tsx`, `FetchingDialog.tsx`.
- `services/web/src/lib/redis.ts`, `services/web/src/lib/net/safe-fetch.ts`,
  `services/web/src/lib/blob-storage.ts`.
- `packages/recipe-extract/` — shared JSON-LD/microdata parser (server-side only;
  **no browser build** — the bookmarklet ships raw JSON-LD/HTML for the server to
  parse). _(Shipped in Phase B.)_
- `services/web/src/routes/bookmarklet[.]js.ts` — tiny loader (find JSON-LD → send,
  else send page HTML; `postMessage` to the bridge tab).
- `services/web/src/server/recipe-scrape.ts` — add `submitImport({ url, jsonld?, html? })`
  (bookmarklet ingest; same `extractRecipe` + import-id cache as `scrapeRecipe`).
- Shared row parsers (if not already present): amount+unit (ingredients) and
  timer/duration (instructions) extractors — reused by editors + downstream.
- New migration under `services/web/src/db/migrations/`.

**Modified**

- `services/web/src/lib/atproto/recipe-writes.ts` — add `uploadRecipeImage`;
  first real callers of `createRecipe`.
- `services/web/src/components/recipes/GlobalRecipePicker.tsx` — demoted to the
  "Add an existing recipe" branch of `AddRecipeChooser` (no longer the primary
  add surface).
- `services/web/src/routes/household.recipes.tsx` +
  `services/web/src/components/recipes/context.ts` — `openAddChooser()`; existing
  "Add" buttons open the chooser (which navigates to the form or opens the picker).
- `services/web/src/components/recipes/DetailPane.tsx` → refactor into a
  controlled presentational `RecipeView` (A6): record-shaped props, no internal
  fetches, optional action callbacks (`onAddToShoppingList?`, `onPublish?`, …).
  Reused by the detail route and the form's Preview modal. Hosts the clickable
  draft lock + Publish dialog (gated by `onPublish?`).
- `services/web/src/routes/household.recipes.$id.tsx` — becomes a thin wrapper
  that loads data + wires callbacks into `RecipeView`.
- `services/web/src/components/recipes/RecipeLedger.tsx` — draft lock marker on
  unpublished rows.
- `services/web/package.json` — `@tanstack/react-form`, `ioredis`.
- `.railway/railway.ts` — Redis service.

---

## Verification (end-to-end, per phase)

Local dev uses the Railway dev Postgres; run migrations with
`railway run --service buttery -- pnpm db:migrate:up` (see memory: Railway run
commands / local dev DB). Drive the real app via the `run` skill.

- **Phase A:** Open the recipes box → Add → **"Add a recipe" chooser** → "Enter
  it manually" → the **full-page form** at `/household/recipes/new`.
  (0) Confirm Save buttons are **disabled** until attribution is chosen
  ("Saving unlocks once the attribution is complete"); "Add an existing recipe"
  in the chooser still opens `GlobalRecipePicker`. (0b) Paste a list into
  Ingredients → editor **auto-flips to Rows**; a row like "some butter" shows a
  **soft ⚠︎ warning** (amount not readable) but does **not** block saving.
  (1) Save with **no attribution** → blocked client+server. (2) Save draft →
  appears in the box, `visibility='draft'`, no atproto `uri`. (3) Save & publish
  → **confirmation dialog** appears first ("makes it public, hard to undo") →
  confirm → row flips to `public` with `uri`/`cid`/`rkey`; verify the record
  exists in the user's PDS repo. (4) Publish a draft later: confirm the **lock icon** shows on the draft's ledger
  row and detail; click the detail lock → Publish dialog → confirm → row goes
  public and the lock disappears. (4b) **Preview:** click `[Preview]` in the form
  with unsaved data → detail modal renders the draft via `RecipeView` (incl. the
  local-object-URL image); action buttons (add-to-shopping-list, publish) are
  absent/disabled. Confirm the same `RecipeView` renders a real saved recipe on
  the detail route with actions wired. (5) Image:
  attach one, publish, confirm blob upload + `embed.images[0]` renders.
  (6) **Cron anti-dupe:** after publishing, run the cron sweep against that DID
  (`railway run --service … -- pnpm … sweep`, scoped via `SYNC_ONLY_DID`) and
  confirm it does **not** create a second rendered `recipe` row — the sweep sees
  the record as already-synced (same `rev`) and no-ops.
- **Phase B:** Chooser → "Import from a URL" → paste a scrapable recipe URL →
  Fetching dialog → form prefills as **"Check the import"** with **attribution
  Locked** to the URL. Import the same URL after it exists as a public record →
  **duplicate dialog** ("Someone already published this one" → "Open the recipe").
  Hit `scrapeRecipe` twice in <60s → second shows only the **generic "slow down"
  message** (no countdown/window revealed). Point at a private IP / `localhost` /
  metadata URL → safe-fetch rejects (SSRF). Import a hostile/403 site → the
  "That page wouldn't open up" dialog (bookmarklet / manual / "Tell Buttery about
  it") shows; the manual fallback keeps attribution locked to the URL.
- **Phase C:** Chooser → "Use the bookmarklet" → install dialog; drag "Save to
  Buttery" to the bookmarks bar. Run it on a JSON-LD recipe page → new Buttery tab
  (the bridge) receives the JSON-LD via `postMessage`, `submitImport` extracts it,
  and the form opens prefilled via `?import=<id>`, attribution locked. Run it on a
  page with **no** JSON-LD → the bookmarklet sends the raw HTML instead and the
  server's `recipe-extract` produces the same prefill (or a partial one). Verify
  save/publish as Phase A. Confirm the loader script serves with a JS content-type
  from our origin, and the bridge ignores `postMessage`s whose origin isn't the
  page it opened.

**Acceptance:** log implementation results to
`docs/plans/results/2026-08-02-create-recipes-results.md` (build log, decisions,
deviations) per repo convention.
