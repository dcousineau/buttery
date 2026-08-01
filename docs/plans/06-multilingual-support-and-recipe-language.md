# 06 — Multilingual support (i18n foundation) + recipe language awareness

Status: **spec / pre-development**
Depends on:

- `03-household-recipe-collection.md` (the `/household/recipes` master–detail
  screen, `RecipeLedger`/`LedgerRow`, `DetailPane`, the `HouseholdRecipeRow` /
  `HouseholdRecipeDetail` payloads) — Part B plumbs language into these.
- `01-atproto-cron-sync-service.md` (the rendered `recipe` layer, `render.ts`
  `project()` / `RenderedRecipe`) — Part B adds a field to the projection.

No design handoff — this is infrastructure + a small badge, not a new screen.

> **Implementation output (do this without being reminded):** when this project
> is built, write the build log / decisions / deviations to
> `docs/plans/results/06-multilingual-support-and-recipe-language-results.md`,
> matching the existing `02-…-results.md` / `03-…-results.md` /
> `05-…-results.md` files in that directory. This is a standing requirement of
> every plan in `docs/plans/`. If Part A and Part B ship as separate PRs, log
> both to that one results file (two dated sections).

---

## 0. Why one spec, two parts

This document covers **two deliberately separate concerns** that happen to land
together:

- **Part A — i18n foundation.** Wire up `react-i18next` + `i18next-cli` so the
  app is _translation-ready_. We ship **English only**; we author **zero**
  non-English translations in this project. The point is to make "wrap it in
  `t()`" a **standing requirement for all new UI** and to make adding a language
  later a content task, not an engineering project.
- **Part B — recipe language awareness.** Recipes are user content synced from
  atproto and can be in _any_ language regardless of the UI language. We record
  each recipe's language and surface a small 2-letter code **only when it differs
  from the current UI language**, so a French recipe is visibly flagged in an
  English UI.

They are independent: Part B's badge compares recipe language against the
current UI locale, but it does **not** require any recipe strings to be
translated, and Part A does **not** touch recipe content. **Either part can ship
first.** Part B is the more self-contained of the two.

Both parts share one guiding constraint from the requester:

> Language is determined **client-side by the browser and/or HTTP headers** for
> now. **Persisted user language settings are explicitly future work** — do not
> build a settings surface, a `user.language` column, or a language switcher in
> this project. Leave a clean seam for it.

---

# PART A — i18n foundation (react-i18next + i18next-cli)

## A1. Overview & goals

Today there is **no i18n** anywhere: every UI string is an inline literal in the
`.tsx` components (`RecipeLedger.tsx`, `DetailPane.tsx`, route files, etc.), and
the document language is hardcoded — `src/routes/__root.tsx:47`
(`<html lang="en" suppressHydrationWarning>`).

Goals, in priority order:

1. **Translation-ready, English-only.** Install and configure the i18n runtime +
   tooling. English is the source language and the only shipped language. No
   `.json` file for any other locale is created in this project.
2. **A going-forward requirement.** After this lands, **all new user-facing
   strings MUST go through `t()` / `<Trans>`**. This is added to `AGENTS.md` (see
   §A8) so every future feature spec inherits it.
3. **SSR-correct.** The app is TanStack Start with SSR (`vite.config.ts`
   `tanstackStart()`). The i18n integration must not leak language state across
   concurrent server requests and must hydrate without a flash/mismatch.
4. **Detection from browser + headers only.** UI locale is resolved from
   `navigator.language` on the client and the `Accept-Language` header on the
   server. No persistence, no cookie writing owned by us (see §A5).
5. **Fast-follow-friendly.** A developer writes English inline via `t()`;
   `i18next-cli` extracts keys into the English catalog and (later, when we add a
   locale) stubs the others. Turning on a real language becomes: add the locale
   code, run `sync`, fill the JSON, register the resource.

### A1.1 In scope

- Add `react-i18next` + `i18next` and `i18next-cli` (dev) to `@buttery/web`.
- An SSR-safe i18n bootstrap (per-request instance) provided through the router.
- Locale detection (client `navigator`, server `Accept-Language`) feeding the
  `<html lang>` at `__root.tsx:47`.
- A namespace layout + the `src/locales/en/*.json` catalogs.
- An `i18next.config.ts` (extract + lint + typegen) and `package.json` scripts.
- Type-safe keys (generated `i18next.d.ts`).
- Convert a **seed set** of existing strings (§A7) to establish the pattern —
  **not** a full string sweep.

### A1.2 Explicitly out of scope

- **Any non-English translation content.** en-only.
- Persisted user language preference / `user.language` column / settings UI /
  in-app language switcher. (Future work; §A5 leaves the seam.)
- URL-based locale routing (`/fr/...`). We detect, we don't route on locale.
- Translating recipe _content_ (that's user data; Part B only _labels_ it).
- Localizing Postgres fulltext search config (noted as a known gap in §B7).
- A remote TMS / Locize. Decision below.

## A2. Decisions (locked with requester)

| Question                   | Decision                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locales scaffolded now     | **English only.** Config `locales: ['en']`.                                                                                                                       |
| Translation workflow / TMS | **Local JSON only.** No Locize. _Who_ translates later is deferred — this spec stays silent on it beyond "run `i18next-cli sync` to stub a new locale."           |
| Detection                  | Browser (`navigator.language`) + `Accept-Language` header. No persistence.                                                                                        |
| File location              | Co-located in web: `services/web/src/locales/{{lng}}/{{ns}}.json`. Not a shared package — `@buttery/web` is the only consumer.                                    |
| Namespacing                | **Per-feature namespaces + a `common`** (§A6).                                                                                                                    |
| Resource loading           | **Bundled** (static `import` of the `en` JSON), _not_ `i18next-http-backend`. en-only means no runtime fetch is warranted; revisit when a second locale is added. |
| Key style                  | Natural-language default values (`t('recipes.empty', 'No recipes yet')`), namespaced. Type-safe via generated types.                                              |

## A3. Dependencies

Add to `services/web/package.json`:

- `dependencies`: `i18next`, `react-i18next`
- `devDependencies`: `i18next-cli`

Do **not** add `i18next-browser-languagedetector` or `i18next-http-backend` —
detection is a tiny bespoke resolver (§A5) and resources are bundled. Adding
them later is a clean, additive change if a second locale needs runtime loading.

## A4. SSR-safe runtime bootstrap

**The concurrency hazard:** react-i18next's common quick-start uses a module
singleton and `i18n.changeLanguage()`. Under SSR a singleton is shared across
concurrent requests, so `changeLanguage` on request A can corrupt the language
seen by request B. We ship en-only so the risk is latent today, but we build it
correctly now so adding `fr` later is pure content.

**Approach — one instance per request on the server, singleton on the client,
provided through TanStack Router context.**

`src/lib/i18n/` (new; follows the `lib/<feature>` convention, cf.
`lib/timers`):

- `resources.ts` — static imports of every `en/*.json` namespace, assembled into
  the `resources` object `{ en: { common, recipes, cook, ... } }`.
- `config.ts` — shared init options (fallbackLng `'en'`, `ns` list,
  `defaultNS: 'common'`, `interpolation.escapeValue: false`, `react.useSuspense:
false` to avoid SSR suspense boundaries).
- `create.ts` — `createI18nInstance(lng: string)`:
  ```ts
  import i18next, { type i18n } from "i18next";
  import { initReactI18next } from "react-i18next";
  export function createI18nInstance(lng: string): i18n {
    const instance = i18next.createInstance();
    instance.use(initReactI18next).init({ ...baseOptions, lng, resources });
    return instance;
  }
  ```
  `createInstance()` (not the default export) is the key: a fresh, isolated
  instance so server requests never share language state.

**Wiring into TanStack Start:**

- Resolve the locale once per request (§A5) and place it on the **router
  context** (router is created per request in Start), alongside the created i18n
  instance. `__root.tsx` reads `context` to (a) render
  `<html lang={locale}>` at `:47` (replace the hardcoded `"en"`), and (b) wrap
  the tree in `<I18nextProvider i18n={context.i18n}>`.
- On the **client**, `createI18nInstance` is called once with the
  client-detected locale and reused (module singleton is fine client-side —
  single user, single language). Hydration reads the same detected value the
  server used so `<html lang>` and rendered text match (no hydration warning).
- Because resources are **bundled**, both server and client have all catalogs in
  memory at init — no async load, no `useSuspense`, no store serialization step
  needed. (If/when we move to http-backend for a second locale, we add
  `initialI18nStore`/`initialLanguage` serialization per react-i18next's SSR
  guide — call this out in the results doc as the follow-up.)

> Implementer note: verify the exact Start context/provider seam against the
> installed `@tanstack/react-start` version — the mechanism (per-request context
> → provider in `__root`) is what matters; the API surface may differ slightly.
> `getRequest().headers` is already used in `src/server/household/session.ts:22-28`,
> so the header-reading seam is proven.

## A5. Locale detection (browser + headers, no persistence)

A single resolver, `src/lib/i18n/detect.ts`, returns a **supported** locale
(currently always `'en'` since that's all we ship, but written to generalize):

- **Server:** parse `getRequest().headers.get('accept-language')`, take the
  highest-q supported match, else `fallbackLng`. (Small hand-rolled parser or a
  tiny helper — do **not** pull in a heavy dep for one header.)
- **Client:** `navigator.languages` / `navigator.language`, first supported
  match, else `fallbackLng`.
- `SUPPORTED_LOCALES = ['en'] as const` lives here as the single source of truth.
  Adding a locale later = add the code here + add its `resources` entry.

**No cookie, no DB, no localStorage** is written by this resolver. This is the
seam for future persisted settings: a later project inserts a
`resolvePersisted() ?? detect()` in front of this function without touching call
sites.

## A6. Namespaces & file layout

Per-feature namespaces keep catalogs small and lazy-loadable later, and map onto
the existing feature folders:

```
src/locales/
  en/
    common.json      # app shell, nav, buttons, generic labels, errors
    recipes.json     # recipe ledger, detail pane, picker, cards
    cook.json        # cook mode + timers UI (project 05 surfaces)
    households.json   # household switch, invites, members, onboarding
    auth.json        # login, oauth, terms/privacy/acknowledgements
```

- `defaultNS: 'common'`. Components declare their namespace:
  `useTranslation('recipes')`.
- Start with these five; add a namespace when a new feature area appears (the
  going-forward rule in §A8 says so).

## A7. Seed conversion (establish the pattern, don't boil the ocean)

Do **not** convert every literal in the app. Convert enough to prove the harness
end-to-end and give `i18next-cli extract` real keys to write:

- `src/routes/__root.tsx` shell/nav strings → `common`.
- **`RecipeLedger.tsx`** row/empty/filter strings and **`DetailPane.tsx`**
  section labels → `recipes`. (These are the highest-traffic surfaces and are
  also touched by Part B.)

Everything else stays as inline literals **until touched** — the going-forward
rule (§A8) converts them organically. Note in the results doc which files were
converted and that the rest is intentionally deferred.

## A8. `i18next-cli` config, scripts, and the going-forward rule

`services/web/i18next.config.ts`:

```ts
import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "src/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
  },
  types: {
    input: ["src/locales/en/*.json"],
    output: "src/types/i18next.d.ts",
    enableSelector: true,
  },
  lint: {
    // flag hardcoded JSX text so new untranslated strings are caught in CI
  },
});
```

`package.json` scripts (mirror the existing `db:*` script grouping):

```
"i18n:extract":  "i18next-cli extract",
"i18n:types":    "i18next-cli types",
"i18n:lint":     "i18next-cli lint",
"i18n:sync":     "i18next-cli sync"   // used only when a NEW locale is added
```

- `i18n:extract` scans `t()`/`<Trans>` usage and writes/updates
  `src/locales/en/*.json` from the default values — English catalogs are
  effectively **generated**, so a developer only ever writes English inline.
- `i18n:types` generates `src/types/i18next.d.ts` giving **type-safe keys**
  (autocomplete + compile error on a typo'd key). Commit the generated file.
- `sync` is the fast-follow lever: when a locale is eventually added to
  `locales`, `sync` stubs its JSON with the English keys for a translator/agent
  to fill. **Not run in this project** (en-only) — documented for the future.

**Going-forward requirement (add to `AGENTS.md`):**

> All new user-facing strings MUST be authored through `react-i18next`
> (`useTranslation` / `t()` / `<Trans>`) with an English default value and an
> appropriate namespace — never as inline literals. Run `pnpm i18n:extract &&
pnpm i18n:types` before committing UI changes. Plans that add UI must state
> which namespace their strings live in.

Wire `i18n:extract` + `i18n:types` into the pre-commit path (`lint-staged` /
husky) or CI so drift is caught; implementer picks the least-friction hook and
records the choice.

## A9. Testing (Part A)

- Unit: `detect.ts` — `Accept-Language` q-value parsing, unsupported →
  fallback, empty header → fallback; `navigator.languages` ordering on client.
- Unit: `createI18nInstance` returns **distinct** instances (identity check) so
  the per-request isolation is guaranteed and can't regress to a singleton.
- Render: a converted component renders English via `I18nextProvider` in test.
- SSR smoke: server render with `Accept-Language: en` produces `<html lang="en">`
  and no hydration mismatch warning.

## A10. Acceptance criteria (Part A)

1. `react-i18next` renders the seed-converted strings; `<html lang>` reflects the
   detected locale (not a hardcoded literal) on both server and client.
2. Distinct i18n instance per server request (no shared `changeLanguage` state).
3. `pnpm i18n:extract` produces/updates `src/locales/en/*.json`; `pnpm
i18n:types` produces `src/types/i18next.d.ts` and typed keys compile.
4. No non-English catalog exists; app is fully functional in English.
5. `AGENTS.md` carries the going-forward `t()` requirement.
6. Zero hydration warnings introduced.

---

# PART B — recipe language awareness

## B1. Overview & goals

Recipes are synced user content and may be in any language. We currently store
**no language information** end-to-end and index everything with the Postgres
`'english'` text config. The French recipe
`01K9WNF5HQNN18HX8P47SP31MV` ("Gratin de chou-fleur au parmesan et jambon cru")
is indistinguishable from an English one to the app.

Goal: **record each recipe's language and surface it — as a 2-letter code — only
when it differs from the current UI language**, in recipe **result rows** and on
the **recipe detail header**. This lets an English-UI user see at a glance that a
recipe is French.

### B1.1 Investigated facts (verified against local dev DB + code)

- `recipe` table has **no language column** (`src/db/types.ts:150-180`).
- The raw atproto record is stored losslessly in
  `atproto_collection_recipe.record` (jsonb).
- **Zero of 3059** recipe records carry any language key — checked
  `inLanguage` / `language` / `lang` / `locale`; all zero. The French record's
  keys are `name, text, $type, embed, cookTime, keywords, prepTime, createdAt,
totalTime, updatedAt, attribution, ingredients, recipeYield, instructions,
cookingMethod, recipeCuisine, recipeCategory` — **no language field.**
- The lexicon `exchange.recipe.recipe.json` has **no language property** at all.
- `render.ts` `project()` (`services/atproto-cron-sync/src/render.ts:241-291`)
  maps a fixed field set; anything not plucked survives only in the raw jsonb.

**Consequence:** there is nothing to extract from raw records _today_ — but the
migration must still do it **defensively** (the requester asked for raw-record
extraction if present), and the French recipe must be **hard-coded** because its
source carries no language. Going forward, capturing language for real requires
adding the field to the lexicon + the sync projection (§B4).

## B2. Decisions (locked with requester)

| Question                                          | Decision                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source of truth                                   | schema.org / atproto **`inLanguage`** when present, else manual backfill.                                              |
| Auto-detection from text                          | **No.** Do not language-detect from recipe text. Unknown stays null.                                                   |
| Existing French recipe                            | **Hard-code backfill** `in_language = 'fr'` in the migration.                                                          |
| Existing records with a language key in raw jsonb | Opportunistically extract in the migration (currently a no-op — zero rows — but required and future-proof).            |
| Badge placement                                   | **Result rows + detail header.**                                                                                       |
| Badge visibility rule                             | Show **only when** the recipe's language subtag **differs** from the current UI locale subtag.                         |
| Badge format                                      | **2-letter** code (primary subtag), uppercased for display (e.g. `FR`).                                                |
| Storage granularity                               | One language per recipe (a `recipe`-level column), storing the full source value; display derives the 2-letter subtag. |

## B3. Data model & migration

New migration in `services/web/src/db/migrations/` (create via `pnpm
db:migrate:new`; it must sort **after** `1785600000000_create_household_recipe_tables.ts`).
Follow the house pattern: `export async function up(db: Kysely<any>)` /
`down`, `Kysely<any>` intentionally (see the frozen-in-time comment in
`1785300000000_create_recipe_rendered.ts:31-33`).

1. **Add column** — nullable, no default:
   ```sql
   ALTER TABLE recipe ADD COLUMN in_language text;
   ```
   Store the **full source value** (could be `fr` or `fr-FR`); the UI derives the
   2-letter subtag. Null = unknown (no badge).
2. **Opportunistic backfill from raw records** (defensive; zero rows match
   today, correct for the future):
   ```sql
   UPDATE recipe r
   SET in_language = acr.record->>'inLanguage'
   FROM atproto_collection_recipe acr
   WHERE acr.did = r.did AND acr.rkey = r.rkey
     AND acr.record ? 'inLanguage'
     AND r.in_language IS NULL;
   ```
3. **Hard-code the known French recipe:**
   ```sql
   UPDATE recipe SET in_language = 'fr'
   WHERE id = '01K9WNF5HQNN18HX8P47SP31MV' AND in_language IS NULL;
   ```
4. **`down`:** `ALTER TABLE recipe DROP COLUMN in_language;`
5. **Re-run codegen:** `pnpm db:codegen` so `src/db/types.ts` picks up
   `in_language: string | null` on the `Recipe` interface. Commit the regenerated
   file. (See the Kysely conventions memory: codegen is the source of DB types.)

## B4. Forward capture (lexicon + sync) — small, do it here

So _future_ synced recipes carry language (not just the one hard-coded row):

- **Lexicon** — add an optional `inLanguage` string property to
  `packages/lexicons/lexicons/exchange.recipe.recipe.json` (BCP-47 language tag;
  optional, not in `required`). Rebuild lexicons (`pnpm --filter
@buttery/lexicons build`, already part of `web` build/dev).
- **Sync projection** — in `services/atproto-cron-sync/src/render.ts`:
  add `inLanguage` to `RenderedRecipe` (`:205-239`), pluck it in `project()`
  (`:241-291`) from the raw record, and include it in the upsert SQL into
  `recipe` (`:297-319`). Mirror the existing nullable-string field handling.

This is additive and low-risk; it means the moment any source record includes
`inLanguage`, it flows through without another migration.

## B5. Payload plumbing

Add an optional language field (name it `inLanguage` to match schema.org / the
column, or `language` — pick one and be consistent; document the choice) to every
recipe payload that feeds a row or a detail header:

| Type                               | File:line                               |
| ---------------------------------- | --------------------------------------- |
| `HouseholdRecipeRow` (ledger row)  | `src/server/household-recipes.ts:19-35` |
| `HouseholdRecipeDetail` (detail)   | `src/server/household-recipes.ts:51-76` |
| `GlobalRecipeResult` (picker)      | `src/server/household-recipes.ts:78-85` |
| `RecipeCardData` (home cards)      | `src/server/recipes.ts:11-52`           |
| `RecipeDetailData` (public detail) | `src/server/recipes.ts:11-52`           |

And add `in_language` to the corresponding SELECTs + row-mapping:

- `listHouseholdRecipes` — SELECT list `household-recipes.ts:150-167`, mapping
  `:183-210`.
- `getHouseholdRecipe` — `household-recipes.ts:220-319`.
- `searchGlobalRecipes` — `household-recipes.ts:449-522`.
- `listRecentRecipes` / `getRecipe` — `src/server/recipes.ts:97-135`, `:138-237`.

The requester's requirement — _"make this language information readily available
in our rendered recipe tables and in the payloads for display"_ — is satisfied
by the `recipe.in_language` column (rendered table) **and** every payload above
carrying it.

## B6. UI — the language badge

New shared component `src/components/recipes/LangBadge.tsx` (recipes feature
folder, cf. the existing `SourceIcon.tsx`):

- **Props:** the recipe's language value (nullable).
- **Logic:** derive the recipe's primary subtag (`fr-FR` → `fr`) and the current
  UI locale's primary subtag (from `react-i18next`'s `i18n.language`, Part A —
  or, if Part B ships first, from a minimal locale read). Render **nothing** when
  the recipe language is null **or** equal to the UI subtag. Otherwise render the
  uppercased 2-letter code as a small badge using vendored UI primitives +
  semantic tokens (per `buttery-design-system`; never literal hexes).
- **Accessibility:** give the badge an accessible label (e.g.
  `aria-label={t('recipes.langBadge', 'French')}` via a language-name lookup, or
  at minimum `title`/`aria-label` with the code) — a bare "FR" is not
  self-describing. Also set the HTML **`lang`** attribute on the rendered
  foreign-language recipe content in the detail view (WCAG 3.1.2 Language of
  Parts): when a recipe's language differs from the page language, wrap its
  title/description/ingredients/instructions in an element with `lang={subtag}`
  so screen readers switch pronunciation. (See the `accessibility-compliance`
  skill.)

Placements:

- **Result rows (primary):**
  - `RecipeLedger.tsx` `LedgerRow` (`:162-197`) — next to the title (`:183`).
  - Home `RecipeCard` (`src/routes/index.tsx:97+`).
  - `GlobalRecipePicker.tsx` result rows.
- **Detail header:** `DetailPane.tsx` header (near the title, `:27+`).

Keep it visually quiet — it only appears for the mismatch case, so it should read
as a subtle marker, not a call to action.

## B7. Known gap (flag, do not fix here)

Postgres fulltext search is **hardcoded to `'english'`** in two places —
`household-recipes.ts:490-491` (`websearch_to_tsquery('english', …)`) and the
render side `render.ts:345-348`. French (and other non-English) recipes are
stemmed with English rules, degrading search quality. **Out of scope** for this
project; record it in the results doc as a follow-up (a future project can key
the `regconfig` off `in_language`). Do not attempt it here.

## B8. Testing (Part B)

- Migration: apply up → `in_language` exists; French row is `'fr'`; down drops
  the column. Re-run `db:codegen`, typecheck passes.
- Subtag logic: `fr-FR` → `fr`; badge hidden when recipe lang == UI lang or
  null; shown (uppercased) when different.
- Payload: a query for the French recipe returns the language field in each
  affected payload.
- Component/render: `LangBadge` renders `FR` for a French recipe under an English
  UI and renders nothing under a French UI; foreign content carries `lang`.
- Sync (if §B4 done): a fixture record with `inLanguage` projects into
  `recipe.in_language`.

## B9. Acceptance criteria (Part B)

1. `recipe.in_language` exists (nullable); the French recipe is `'fr'`; the
   defensive raw-record extraction is present in the migration.
2. `src/db/types.ts` regenerated with the new column; typecheck green.
3. Every listed payload carries the language field, sourced from the column.
4. The 2-letter badge appears in result rows **and** the detail header **only
   when** recipe language ≠ UI language; hidden otherwise.
5. Foreign-language recipe content in the detail view carries a `lang` attribute.
6. Lexicon + sync capture `inLanguage` for future records (§B4).
7. The fulltext-`'english'` limitation is recorded as a follow-up (not fixed).

---

## Results (both parts)

Write the build log — decisions, deviations, what was converted vs. deferred, the
pre-commit/CI hook chosen for `i18n:extract`/`i18n:types`, and the fulltext
follow-up — to
**`docs/plans/results/06-multilingual-support-and-recipe-language-results.md`**,
matching the format of the existing `*-results.md` files. Required, not optional.
