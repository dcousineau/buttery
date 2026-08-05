<!-- intent-skills:start -->

## Skill Loading

Before edit files for big task:

- Run `pnpm dlx @tanstack/intent@latest list` from workspace root. See local skills.
- Skill match task → run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before change files.
- Use loaded `SKILL.md` guidance while change.
- Monorepos: work across packages → run skill check from workspace root, prefer local skill for changed package.
- Many matches: prefer most specific local skill for changed package/concern. Load extra skills only when task span many packages/concerns.

<!-- intent-skills:end -->

# Project: buttery

Blank TanStack Start app (React). No extra integration, no feature scaffold.

## How this project was scaffolded

- Scaffolded 2026-07-19 with TanStack CLI:
  `npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind`
  (CLI v0.69.6; `--tailwind` flag dead/ignored — Tailwind always on in Start scaffolds.)
- Made in scratch dir, merged into repo root (repo `.git` kept; scaffold git init tossed). Package renamed `my-tanstack-app` → `buttery` in `package.json`.
- Follow-up commands from repo root:
  - `npx @tanstack/intent@latest install` — wired skill-loading guidance into this file
  - `npx @tanstack/intent@latest list` — 31 skills across 9 intent-enabled packages

## Toolchain (mise)

- System tooling (node, pnpm, Railway CLI, process-compose) run by [mise](https://mise.jdx.dev) via `mise.toml`. Install mise first (`brew install mise` + shell activation), then `mise install` from repo root.
- `mise install` give node 26 / pnpm 11 / railway / process-compose. Then `postinstall` hook run `mise run railway-skills` (`railway skills install`) so Railway agent skills ready. Note: Railway CLI install skills global only (`~/.agents/skills`, `~/.claude/skills`, etc.) — no project-scoped mode; use `--agent claude-code` to narrow targets.
- Fresh clones must `mise trust` before hooks/tasks run (`mise install` prompts).
- First-time setup: Railway MCP server not set (check `railway mcp install --help` or tool MCP list) → suggest install — `railway mcp install` add to Claude Code/Cursor/OpenCode/Codex, or `railway setup agent -y` do skills + MCP + login one step.
- New major CLIs/tools go in `[tools]` in `mise.toml`, not homebrew or npm globals.

## Stack and integrations

- TanStack Start (React 19) + TanStack Router (file-based routes in `src/routes/`)
- Vite 8 (default CLI toolchain), TypeScript 7 (native compiler; see TODO below for 6/7 side-by-side setup), Tailwind CSS v4 (via `@tailwindcss/vite`)
- Vitest + Testing Library + jsdom for tests
- TanStack Devtools (dev-only; stripped from prod builds by `@tanstack/devtools-vite`)
- Auth: better-auth (sessions in postgres via pg Pool) + custom atproto OAuth plugin
  (`src/lib/atproto/better-auth-plugin.ts`, server-side `@atproto/oauth-client-node` —
  DPoP/PAR; DID = identity, synthetic email). Handler at `src/routes/api/auth/$.ts`,
  client via `authClient` (`src/lib/auth-client.ts`). Atproto only sign-in method.
- Atproto records: `@atproto/lex` codegen (NOT `@atproto/api`, removed). Read/validate/write
  `exchange.recipe.*` via generated types. See "Atproto lexicons" section.

## Scripts

- `pnpm dev` — boot the whole local stack via process-compose (containers, migrations, atproto dev-env, web on port 3000). See "Local development" below and `docs/LOCAL-DEV.md`
- `pnpm dev:attach` / `pnpm dev:down` — attach the TUI to the running stack / stop it and the containers
- `pnpm dev:web` — web dev server alone (no supervisor, no containers)
- `pnpm build` — prod build (client + SSR server to `dist/`)
- `pnpm start` — prod server via srvx (`dist/server/server.js` + static `dist/client`; respects `PORT`)
- `pnpm preview` — preview prod build
- `pnpm test` — vitest run
- `pnpm typecheck` — native TS 7 `tsc` (noEmit); `tsc6` binary also there (TS 6 API)
- `pnpm lint` — eslint (flat config, TS + react-hooks)
- `pnpm format` — prettier whole repo (rarely needed; see Gotchas)
- `pnpm generate-routes` — regen `src/routeTree.gen.ts` (usually auto via Vite plugin)
- `pnpm db:migrate:up` — apply all pending migrations (kysely-ctl `migrate latest`)
- `pnpm db:migrate:down` — roll back last migration
- `pnpm db:migrate:new <name>` — scaffold new migration in `src/db/migrations/`
- `pnpm db:migrate:list` — show migration status
- `pnpm db:codegen` — regen `src/db/types.ts` from live DB (dev-only)
- `pnpm lex:build` — regen `src/lexicons/` TS from `lexicons/*.json` (cleans dir first; lex build not idempotent). Auto-runs before dev/build/typecheck.
- `pnpm lex:install <nsid>…` — resolve + vendor a lexicon into `lexicons/` (network; may need patching, see PATCHES.md)

## Structure

- **Mono-repo (pnpm workspace):** web app at `services/web` (pkg `@buttery/web`), atproto lexicons at `packages/lexicons` (`@buttery/lexicons`). Paths below are relative to `services/web/`. Run package scripts from root via `pnpm --filter @buttery/web <script>` (bare `pnpm dev`/`pnpm build` still delegate to the web app).
- `src/routes/` — file-based routes (`__root.tsx` document shell, `index.tsx`, `about.tsx`)
- `src/router.tsx` — `getRouter()` factory
- `src/routeTree.gen.ts` — generated; never hand-edit
- `src/server/` — server business logic (the `createServerFn` RPC/data surface + its pure, tested domain modules); first-class as routes, NOT generic `lib/` utils. `server/recipes.ts` (recipe read loaders), `server/authz.ts` (generic membership/role assertion, cross-feature), `server/household/` (household feature: server fns + `ids`/`invite-token`/`errors`/… + tests). Intra-folder deps import via `./`; reach into shared code via `#/lib/*`.
- `src/lib/` — shared, mostly client-safe utils: `format`, `seo`, `utils` (`cn()`), `config`, `db` (`getDb()`), `auth`/`auth-client`, `hooks/`, `atproto/`
- `src/components/` — AppShell (SidebarProvider layout), AppSidebar, Header, Footer, ThemeToggle, ButterStick (brand mark)
- `src/components/ui/` — vendored shadcn primitives (ours to edit); `src/lib/hooks/` (`use-mobile.ts`, `use-theme.ts`), `src/lib/utils.ts` (`cn()`)
- `#/*` import alias → `./src/*` (package.json `imports` field)
- `tsr.config.json` — router CLI config; `vite.config.ts` — plugin order matters (`devtools-vite` must stay first)

## Design system (shadcn + Buttery brand)

- Read `docs/BRAND.md` BEFORE any UI/design work — palette, type, neo-brutalist kit, one control-height scale, token mapping, don'ts.
- shadcn style `base-nova` = **Base UI primitives, not Radix**: custom triggers use `render={<a/>}` prop, never `asChild`. When `render` swap Button to non-`<button>` (`<a>`, `<Link>`), add `nativeButton={false}` or Base UI warn at runtime and drop button semantics.
- Components are vendored source in `src/components/ui/`, on-purpose customized (border-2 ink, `shadow-pop*` hard shadows, sticker hover physics in button). Inline controls (Button/Badge/Input/Select/Textarea) share ONE `size` scale — pick a size, never hand-set a height. New primitive: `pnpm dlx shadcn@latest add <x>`, then neo-brutalise to match before use.
- App code: semantic tokens only (`bg-primary`, `text-muted-foreground`); never raw hexes or `bg-[var(--butter)]` (brand colors shown as `bg-butter*` for rare mascot/hero moments).
- Dark mode keys off `.dark` class (`@custom-variant dark` in `src/styles.css`); theme init script in `__root.tsx` + ThemeToggle keep it.
- Dark-mode borders/strokes = a dark color lifted just above bg, NOT the near-white foreground (`--border`/`--input`/`--sidebar-border` in `.dark`). Brand logo (`ButterStick`) faces use fixed light fills so they don't flip dark with the theme.

## SEO / social meta

- `src/lib/seo.ts` builds the `head()` `meta` array. Root (`__root.tsx`) sets site defaults; any route overrides via `head: () => ({ meta: seo({ title, description, image }) })`. Deepest matched route wins (HeadContent dedupes by `name`/`property`).
- `og:url` + `<link rel="canonical">` are NOT in `seo()` — they're per-page, emitted globally in `__root.tsx` from the current pathname (`absolute(pathname)`). Don't add a `url`/canonical arg back to `seo()`.
- Absolute origin comes from `siteUrl()` = `import.meta.env.VITE_APP_URL` (Vite-inlined at build into both bundles). `VITE_APP_URL` mirrors `BETTER_AUTH_URL` — set from one `publicOrigin` const in `.railway/railway.ts`, and in `.env`/`.env.example` for dev. It MUST be present at **build** time (client inline), so it lives in the service env, not just runtime.
- **We do absolutely nothing Twitter/X-specific.** No `twitter:card`, `twitter:*`, `twitter:site` tags. We emit only standards-based Open Graph (`og:*`) + plain `<meta name="description">`. Twitter/X consumes OG tags fine; every other platform (Slack, Discord, Signal, iMessage, Mastodon, Bluesky, LinkedIn) reads OG too. One standard, no vendor carve-outs. Don't add Twitter tags.
- OG image is a static asset (`public/og-image.png`, 1200×630; source SVG at `public/og-image.svg`) — TanStack Start has no built-in OG image generator. `seo()` resolves it absolute against `SITE_URL` and hardcodes `og:image:width/height/type` to the 1200×630 PNG (fix those if a route ships a different image).
- `public/robots.txt` **disallows all crawlers** during alpha (`Disallow: /`) — flip to `Disallow:` at public launch.
- Recipe detail (`src/routes/recipes.$id.tsx`) emits schema.org/Recipe two ways: JSON-LD via `buildRecipeLd()` AND inline microdata (`itemProp`) on the visible DOM — keep the two in sync. Recipe time fields (`prepTime`/`cookTime`/`totalTime`) are ISO-8601 durations, passed raw to schema.

## Accessibility (non-negotiable)

**All frontend work MUST be WCAG A compliant at minimum; aim for AA.** Color-contrast and
visibility rules from AA can be loose — strict AA contrast ratios not
required, but design choices should lean toward AA, not away.
Everything else at AA (keyboard operability, focus visibility, labels/roles, reduced
motion, touch targets) expected, not optional.

Write new UI code, lean on `accessibility-compliance` skill (`/accessibility-compliance`) to check patterns and catch violations before ship.

## Gotchas (frontend)

- Global element CSS MUST go in `@layer base` — unlayered rules beat Tailwind utilities (caused red-on-red button bug). Prose-link styling scoped to `a:not([class])`.
- Tailwind v4 preflight set buttons `cursor: default`; counter-rule in `@layer base` give clickables `cursor: pointer` — don't remove.
- shadcn CLI interactive prompts ignore `--yes` for config questions; piping `yes ""` write wrong `components.json` (rsc:true, `app/globals.css`). Verify/hand-fix `components.json` after `init` (correct: rsc false, css `src/styles.css`, `#/` aliases).
- Stock shadcn hooks can fail `react-hooks/set-state-in-effect` lint — `use-mobile.ts` rewritten with `useSyncExternalStore`; prefer that pattern.
- Restructure `@import`/`@layer` in `styles.css` can silently break Vite CSS HMR — hard-reload browser before debug "stale" styles.
- Browser-automation a11y checks: assert DOM programmatically via chrome MCP `javascript_tool` (focus order, `activeElement`, aria attrs, heading tree) — faster/surer than screenshots.
- Drive React controlled input from automation: `computer type` miss if focus drift; instead set value via `HTMLInputElement.prototype` native setter + dispatch `input` event + `form.requestSubmit()`.
- Vite auto-bumps 3000→3001+ if the port is busy — check `.dev-logs/web.log` for the real URL. Usual cause is a second dev server; `process-compose process list` shows whether the stack already owns 3000.

## Environment variables

- `DATABASE_URL` (server-only) — postgres connection string, read via `getPool()` in `src/lib/db.ts`. On Railway: referenced from postgres service. Locally: injected by `railway run --service buttery --` (pointing at the `railway dev` postgres) or set in `.env` (see `.env.example`).
- `BETTER_AUTH_SECRET` (server-only) — better-auth session signing secret, 32+ chars.
- `BETTER_AUTH_URL` — public origin; drives better-auth baseURL and atproto OAuth client_id/redirect URI.
- Client-exposed vars need `VITE_` prefix. Server-only secrets stay unprefixed, read via `process.env` in server code only.

## Deployment (Railway)

- Railway project `buttery` (Free plan), one app service `buttery` + `postgres` database (`postgres-ssl:18`, latest major). Live at https://buttery-production.up.railway.app.
- Infra is code: `.railway/railway.ts` (TypeScript IaC via `railway` devDependency). Edit it, then `railway config plan` to preview, `railway config apply` to apply. Never hand-edit dashboard state IaC owns.
- App deploys from local checkout: `railway up --service buttery --detach`, then poll `railway deployment list --json` until `SUCCESS`. Service builds with `pnpm run build`, runs `pnpm start` (srvx, binds `PORT`). GitHub-triggered deploys: add `source: github("dcousineau/buttery")` to service in `.railway/railway.ts`.
- `DATABASE_URL` on app service = reference to postgres service — never set by hand.
- Free plan limits: $1 usage credit/mo, 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB volume per service. Keep to this one service + postgres; no extra environments/replicas.
- Do NOT use nitro vite plugin for hosting — nitro-nightly prod output self-fetches (`fetch(req, { viteEnv: "ssr" })`), breaks. srvx = working Node hosting path for this Start version.

## Local development

**One supervised, singleton process-compose stack (`process-compose.yaml`) runs everything: the `railway dev` containers, migrations, the atproto dev-env, and the web server.** Boot it with `pnpm dev`. Load the `local-dev` skill for the day-to-day commands; read `docs/LOCAL-DEV.md` before changing the stack itself.

- **Agents drive the stack, never ask the user to.** If it's already up (the human may be watching the TUI), use the CLI against the running instance — it talks to the REST API on port 8099 (`PC_PORT_NUM` in `mise.toml`):
  - `process-compose process list -o wide` — status + health of every process
  - `process-compose process logs web --tail 50` — or grep `.dev-logs/<process>.log`
  - `process-compose process restart web` — restart ONE process; don't tear down the stack
  - `process-compose project state` — cheap "is it running?" probe (non-zero exit when not)
- **Never start a second copy of a dev server.** `pnpm dev` attaches when the stack is already up; a bare `pnpm dev:web` alongside it will fight for port 3000.
- Restarting `atproto-dev-env` mints a new `did:plc` (in-memory PDS) — any browser session needs re-sign-in after.
- `pnpm dev:down` stops the stack AND the containers. `process-compose down` alone leaves the containers up (they're detached; process-compose only tails their logs).

**`railway dev` runs external services ONLY — postgres, redis, and the Caddy proxy. It never starts the app.**

- This is a convention, not a committed setting. Which code services `railway dev` runs lives in machine-local CLI state at `~/.railway/develop/<project-id>/local-dev.json` (project id maps to this repo via `~/.railway/config.json`) — not in the repo, not tracked, not inherited by a fresh clone. Empty (`"services": {}`) is both the default and what we want. **Do not run `railway dev configure`** to add the app; keep app processes under your own control so they can be restarted and log-inspected independently of the containers.
- `railway dev` bootstraps the images and prints a config overview (host ports, connection info). Already running → it re-prints that overview instead of doing anything destructive, so it's safe to run just to read the current setup. `railway dev down` stops; `railway dev clean` wipes data.
- **Never hardcode the postgres host port** — it is regenerated and has changed across setups (17754 → 33628). Read it from the `railway dev` overview, or let `railway run` inject it.
- `railway run --service <svc> -- <cmd>` injects the local service vars (`DATABASE_URL`, `REDIS_URL`, …) into the wrapped command. This is the normal way to run anything that needs the DB:
  - migrations: `railway run --service buttery -- pnpm --filter=@buttery/web db:migrate:up`
  - web dev server alone: `railway run --service buttery -- pnpm dev:web` (this is exactly what the `web` process in `process-compose.yaml` runs)
- Bare `pnpm dev:web` also works when `services/web/.env` holds the vars, but that file goes stale when ports are regenerated. Prefer `railway run` for anything DB-touching.
- `railway dev`/`railway run` inject vars that WIN over local shell exports (`COMING_SOON=false railway run …` stays `true`; `--no-local` no help). To override locally, prefix child command: `railway run env COMING_SOON=false pnpm dev`. `.env` can't override this — Vite only loads `VITE_`-prefixed vars into `process.env`.
- atproto OAuth: `oauth-node.ts` collapses any local hostname (incl. `*.localhost`) to `http://127.0.0.1:3000` — atproto forbids `.localhost` TLDs in web client_ids, so local dev always uses the loopback client. Browse http://127.0.0.1:3000.
- railway-dev postgres volume starts empty, persists across restarts. `pnpm dev`'s `migrate` process covers this on every boot (including after `railway dev clean`); only run migrations by hand outside the stack.
- `railway dev up --dry-run --no-tui` regen `~/.railway/develop/<project-id>/docker-compose.yml` (ports/creds source of truth) but delete it when dry-run exits — read while `railway dev` actually running, or right after regen.
- Alternative: own postgres + `DATABASE_URL` in `.env` (see `.env.example`), or `railway run pnpm dev` against _production_ database vars (careful).

## Database (Kysely + migrations)

- All SQL goes through shared, typed Kysely instance from `src/lib/db.ts` (`getDb()`). better-auth shares same instance (`database: { db: getDb(), type: "postgres" }` in `src/lib/auth.ts`). Prefer Kysely query-builder primitives over raw `sql`.
- Read-side data loaders: `createServerFn({ method: "GET" })` + dynamically `import` `getDb` from `#/lib/db` INSIDE the handler (mirror `src/lib/gate.ts`'s dynamic `posthog-server` import) — keeps `pg` out of the client bundle when the module is also imported client-side (e.g. `src/server/recipes.ts`).
- Schema owned by **kysely-ctl migrations** in `src/db/migrations/` (config: `services/web/kysely.config.ts`, reuses shared pool + loads `services/web/.env`). Initial migration ports whole better-auth + atproto schema. `scripts/better-auth.sql` is historical source, now superseded.
- **ALWAYS run `pnpm db:codegen` right after `pnpm db:migrate:up` when work locally** — regen `src/db/types.ts` (the `DB` interface) from live DB so types match schema. `types.ts` generated; never hand-edit.
- Prod migrations run auto on deploy via Railway pre-deploy (`preDeploy: "pnpm db:migrate:up"` in `.railway/railway.ts`). This why `kysely-ctl` lives in `dependencies` (Railpack prunes devDeps from runtime image); `kysely-codegen` is true devDependency and never runs in prod.
- Better-auth schema changes (new plugins/fields): atproto plugin declares its tables in `src/lib/atproto/better-auth-plugin.ts`. After change auth schema, write new migration (`pnpm db:migrate:new …`) with DDL, apply it, then `pnpm db:codegen`.

## Atproto lexicons (@atproto/lex)

- `lexicons/*.json` = vendored source of truth (committed). `src/lexicons/**` = generated TS (gitignored + eslint-ignored). Rebuild: `pnpm lex:build`.
- **Read `lexicons/PATCHES.md` before touching lexicons or re-pulling upstream.** recipe.exchange lexicons non-conformant to strict lex-schema 0.2.2 (float→string, `union`-of-`token`→`string`+`knownValues`, inline objects→named `ref` defs, unsupported string formats stripped). Patches hand edits NOT tracked by CID manifest.
- Read path: prefer lex's typed `xrpc(url, queryDef, {params})` — returns `XrpcResponse`; body at `.payload.body`; blobs/CIDs pre-decoded (no `jsonToLex` needed). Raw `fetch`+JSON instead? call `jsonToLex(value)` before `$parse`/`$safeParse` or blobs fail `expected: ['blob']`.
- Validate records with generated `recipeLex.$safeParse(...)` (module in `src/lexicons/exchange/recipe/`). See `src/lib/atproto/recipes.ts` (read) + `recipe-writes.ts` (authenticated `Client` writes).
- Auth writes: `restore(did)` OAuthSession IS a lex `Agent` → `new Client(session)`; `client.create(recipe, fields)`.

## Code style

- Interacting with 3rd-party API-client types (esp. lex): NO `as` casts to satisfy branded types — convert at boundary with library's own validator (lex: `$params.parse(...)`, `asDatetimeString(...)` / `currentDatetimeString()`). Casts hide upstream breakage.
- Prefer inferred return types on functions wrapping a client — don't annotate — so client shape change surfaces as compile error downstream.

## Gotchas

- Claude Code command sandbox network allowlist excludes the dev DB host AND `localhost:3000` — `curl localhost:3000` returns `000`, DB/migration commands can't connect. Run those via `!` in the prompt (or sandbox-disabled); verify running pages through the Chrome MCP tools, not `curl`.
- `pnpm add`/`pnpm install` fail under Claude Code command sandbox (`ERR_PNPM_UNEXPECTED_STORE` / `ERR_SQLITE_ERROR` — store sqlite write blocked). Run pnpm installs with sandbox disabled.
- `pnpm install` also fails with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (non-interactive modules-dir removal) — run `CI=true pnpm install`; add `--no-frozen-lockfile` after editing a package.json (else `ERR_PNPM_OUTDATED_LOCKFILE`).
- pnpm 11 warns `pnpm.onlyBuiltDependencies` in package.json ignored (moved to pnpm settings); harmless, esbuild/lightningcss build scripts still work.
- Several TanStack deps pinned to `latest` in package.json (CLI default); lockfile pins real versions.
- Use intent skills above before router/start architectural changes — no guessing patterns.
- Local port 5432 usually unrelated `core-api-postgres-1` container — NOT buttery's DB. Use `railway dev` or throwaway container on another port.
- Dev OAuth: browse http://127.0.0.1:3000, never localhost — atproto loopback redirect and session cookie bound to 127.0.0.1 (vite already binds that host).
- Railway iac secrets: `{ generator: "secret(44)", preserveExisting: true }` gen per-environment on first apply, never overwrite existing values.
- Recipe ids ARE atproto rkeys — permit `-`, `.`, `_`, `:`, `~`, up to 512 chars, NOT just ULID/TID shape. Don't validate id format (a shape regex WILL reject real ids); DB existence is the only source of truth. Missing id → return null → NotFound. `getRecipe` validator caps length only.
- `pnpm test` exits 1 — no test files yet.
- `tsr generate` rewrites `createFileRoute()` path literals (e.g. normalizes `[.]` escapes) — don't fight it.
- Prettier enabled but make NO special effort to run — husky pre-commit hook runs
  `lint-staged` (prettier --write + eslint --fix on staged files) auto.

## TODO: collapse TypeScript 6/7 side-by-side setup once TS 7.1 API lands

TypeScript 7.0 (native Go compiler) ships without programmatic API, so `typescript-eslint`
can't use it until TypeScript 7.1. Per official TS 7.0 announcement, run 6 and 7
side-by-side via npm aliases in `package.json`:

- `"@typescript/native": "npm:typescript@^7.0.2"` — native `tsc` binary (v7),
  used by `pnpm typecheck`.
- `"typescript": "npm:@typescript/typescript6@^6.0.2"` — `typescript` module name resolves
  to TS 6 API for typescript-eslint, editors, other tooling; also provides `tsc6`.

**Agent instruction:** moment you notice `typescript` upgraded such that
typescript-eslint supports TS >= 7.1 (tracking: https://github.com/typescript-eslint/typescript-eslint/issues/10940),
do this migration: replace both aliases with plain `"typescript": "^7.1.0"` (or current)
devDependency, upgrade `typescript-eslint` to version supporting it, run `pnpm install`,
verify `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass, then DELETE this whole
TODO section from AGENTS.md and update Stack section's TypeScript line.

## Next steps

- Auth wired (2026-07-23): prod DB schema applied, Railway vars set. Untested: interactive atproto callback leg (needs browser sign-in). Deploy with `railway up` when ready.

## Bash command style

The permission analyzer cannot parse certain shell syntax, and each
occurrence triggers a manual approval prompt. Never include in Bash
tool calls:

- Variable expansion: $VAR, ${VAR} ("simple_expansion")
- Command substitution: $(...)
- KEY=value environment prefixes
- Complex quoting/escaping ("node type: string")
  Use literal values and paths instead. If a command genuinely needs
  these features, write it to a .sh file with the Write tool and run
  `bash file.sh` — script invocations always parse cleanly.

## Git in worktrees

Never use `cd <dir> && git ...` — it triggers a manual approval prompt.
Always use `git -C <dir> ...` to run git commands in a worktree or any
directory other than the cwd. For non-git commands that need a different
working directory, prefer running them via a script file in that
directory rather than `cd &&` chains where possible.
