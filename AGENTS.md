<!-- intent-skills:start -->

## Skill Loading

Before editing files for substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from workspace root to see local skills.
- Listed skill match task → run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use loaded `SKILL.md` guidance while changing.
- Monorepos: work across packages → run skill check from workspace root, prefer local skill for package changed.
- Multiple matches: prefer most specific local skill for package/concern changed. Load extra skills only when task spans multiple packages/concerns.

<!-- intent-skills:end -->

# Project: buttery

Blank TanStack Start app (React). No extra integrations, no feature scaffolding.

## How this project was scaffolded

- Scaffolded 2026-07-19 with TanStack CLI:
  `npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind`
  (CLI v0.69.6; `--tailwind` flag deprecated/ignored — Tailwind always on in Start scaffolds.)
- Generated into scratch dir, merged into repo root (repo's existing `.git` kept; scaffold's git init discarded). Package renamed `my-tanstack-app` → `buttery` in `package.json`.
- Follow-up commands from repo root:
  - `npx @tanstack/intent@latest install` — wired skill-loading guidance into this file
  - `npx @tanstack/intent@latest list` — 31 skills across 9 intent-enabled packages

## Toolchain (mise)

- System tooling (node, pnpm, Railway CLI) managed by [mise](https://mise.jdx.dev) via `mise.toml`. Install mise first (`brew install mise` + shell activation), then `mise install` from repo root.
- `mise install` gives node 26 / pnpm 11 / railway. Then `postinstall` hook runs `mise run railway-skills` (`railway skills install`) so Railway agent skills available. Note: Railway CLI installs skills globally only (`~/.agents/skills`, `~/.claude/skills`, etc.) — no project-scoped mode; use `--agent claude-code` to narrow targets.
- Fresh clones must `mise trust` before hooks/tasks run (`mise install` prompts).
- First-time setup: Railway MCP server not configured (check `railway mcp install --help` or tool's MCP list) → suggest install — `railway mcp install` adds to Claude Code/Cursor/OpenCode/Codex, or `railway setup agent -y` does skills + MCP + login in one step.
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

## Scripts

- `pnpm dev` — dev server, port 3000
- `pnpm build` — prod build (client + SSR server to `dist/`)
- `pnpm start` — prod server via srvx (`dist/server/server.js` + static `dist/client`; respects `PORT`)
- `pnpm preview` — preview prod build
- `pnpm test` — vitest run
- `pnpm typecheck` — native TS 7 `tsc` (noEmit); `tsc6` binary also available (TS 6 API)
- `pnpm lint` — eslint (flat config, TS + react-hooks)
- `pnpm format` — prettier whole repo (rarely needed; see Gotchas)
- `pnpm generate-routes` — regenerate `src/routeTree.gen.ts` (usually automatic via Vite plugin)

## Structure

- `src/routes/` — file-based routes (`__root.tsx` document shell, `index.tsx`, `about.tsx`)
- `src/router.tsx` — `getRouter()` factory
- `src/routeTree.gen.ts` — generated; never hand-edit
- `src/components/` — AppShell (SidebarProvider layout), AppSidebar, Header, Footer, ThemeToggle, ButterStick (brand mark)
- `src/components/ui/` — vendored shadcn primitives (ours to edit); `src/hooks/use-mobile.ts`, `src/lib/utils.ts` (`cn()`)
- `#/*` import alias → `./src/*` (package.json `imports` field)
- `tsr.config.json` — router CLI config; `vite.config.ts` — plugin order matters (`devtools-vite` must stay first)

## Design system (shadcn + Buttery brand)

- Read `docs/BRAND.md` BEFORE any UI/design work — palette, type, pop-art kit, token mapping, don'ts.
- shadcn style `base-nova` = **Base UI primitives, not Radix**: custom triggers use `render={<a/>}` prop, never `asChild`.
- Components are vendored source in `src/components/ui/`, deliberately customized (border-2 ink, `shadow-pop*` hard shadows, sticker hover physics in button). New primitive: `pnpm dlx shadcn@latest add <x>`, then pop-art-ify to match before use.
- App code: semantic tokens only (`bg-primary`, `text-muted-foreground`); never raw hexes or `bg-[var(--butter)]` (brand colors exposed as `bg-butter*` for rare mascot/hero moments).
- Dark mode keys off `.dark` class (`@custom-variant dark` in `src/styles.css`); theme init script in `__root.tsx` + ThemeToggle maintain it.

## Accessibility (non-negotiable)

**All frontend work MUST be WCAG A compliant at minimum; aim for AA.** Color-contrast and
visibility rules from AA may be loosely interpreted — strict AA contrast ratios not
required, but design decisions should lean toward AA compliance, not away.
Everything else at AA (keyboard operability, focus visibility, labels/roles, reduced
motion, touch targets) expected, not optional.

Writing new UI code, lean on `accessibility-compliance` skill (`/accessibility-compliance`) to check patterns and catch violations before ship.

## Gotchas (frontend)

- Global element CSS MUST go in `@layer base` — unlayered rules beat Tailwind utilities (caused red-on-red button bug). Prose-link styling scoped to `a:not([class])`.
- Tailwind v4 preflight sets buttons `cursor: default`; counter-rule in `@layer base` gives clickables `cursor: pointer` — don't remove.
- shadcn CLI interactive prompts ignore `--yes` for config questions; piping `yes ""` writes wrong `components.json` (rsc:true, `app/globals.css`). Verify/hand-fix `components.json` after `init` (correct: rsc false, css `src/styles.css`, `#/` aliases).
- Stock shadcn hooks can fail `react-hooks/set-state-in-effect` lint — `use-mobile.ts` rewritten with `useSyncExternalStore`; prefer that pattern.
- Restructuring `@import`/`@layer` in `styles.css` can silently break Vite CSS HMR — hard-reload browser before debugging "stale" styles.
- Browser-automation a11y checks: assert DOM programmatically via chrome MCP `javascript_tool` (focus order, `activeElement`, aria attrs, heading tree) — faster/surer than screenshots.
- Driving React controlled input from automation: `computer type` misses if focus drifted; instead set value via `HTMLInputElement.prototype` native setter + dispatch `input` event + `form.requestSubmit()`.
- `pnpm dev` auto-bumps 3000→3001+ if port busy — check startup log for actual URL.

## Environment variables

- `DATABASE_URL` (server-only) — postgres connection string, read via `getPool()` in `src/lib/db.ts`. On Railway: referenced from postgres service. Locally: injected by `railway dev` or set in `.env` (see `.env.example`).
- `BETTER_AUTH_SECRET` (server-only) — better-auth session signing secret, 32+ chars.
- `BETTER_AUTH_URL` — public origin; drives better-auth baseURL and atproto OAuth client_id/redirect URI.
- Client-exposed vars need `VITE_` prefix. Server-only secrets stay unprefixed, read via `process.env` in server code only.

## Deployment (Railway)

- Railway project `buttery` (Free plan), one app service `buttery` + `postgres` database (`postgres-ssl:18`, latest major). Live at https://buttery-production.up.railway.app.
- Infrastructure is code: `.railway/railway.ts` (TypeScript IaC via `railway` devDependency). Edit it, then `railway config plan` to preview, `railway config apply` to apply. Never hand-edit dashboard state IaC owns.
- App deploys from local checkout: `railway up --service buttery --detach`, then poll `railway deployment list --json` until `SUCCESS`. Service builds with `pnpm run build`, runs `pnpm start` (srvx, binds `PORT`). GitHub-triggered deploys: add `source: github("dcousineau/buttery")` to service in `.railway/railway.ts`.
- `DATABASE_URL` on app service = reference to postgres service — never set manually.
- Free plan limits: $1 usage credit/mo, 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB volume per service. Keep to this one service + postgres; no extra environments/replicas.
- Do NOT use nitro vite plugin for hosting — nitro-nightly prod output self-fetches (`fetch(req, { viteEnv: "ssr" })`), breaks. srvx = working Node hosting path for this Start version.

## Local development with postgres

- Preferred: `railway dev` (Railway local emulation, experimental). Generates docker-compose from Railway environment, runs postgres locally with same `postgres-ssl:18` image, injects `DATABASE_URL` into code services. Needs Docker. `railway dev down` stops; `railway dev clean` wipes data; `railway dev configure` sets how app service runs locally (e.g. `pnpm dev`, port 3000).
- Verified local flow (2026-07-23): terminal A `railway dev` (postgres on host port **17754**, same creds as prod), terminal B `pnpm dev` with `.env` holding `DATABASE_URL=postgresql://postgres:<pw>@localhost:17754/railway`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://127.0.0.1:3000`. Vite dev loads `.env` into `process.env` — confirmed working end-to-end.
- Running app _inside_ `railway dev` also works: injects/rewrites `BETTER_AUTH_URL` to `https://buttery.buttery.railway.localhost`, but `oauth-node.ts` collapses any local hostname (incl. `*.localhost`) to `http://127.0.0.1:3000` — atproto forbids `.localhost` TLDs in web client_ids, so local dev always uses loopback client. Either way, browse http://127.0.0.1:3000.
- railway-dev postgres volume starts empty, persists across restarts. Apply `scripts/better-auth.sql` once after first start (again after `railway dev clean`).
- `railway dev up --dry-run --no-tui` regenerates `~/.railway/develop/<project-id>/docker-compose.yml` (ports/creds source of truth) but deletes it when dry-run exits — read while `railway dev` actually running, or immediately after regenerating.
- Alternative: own postgres + `DATABASE_URL` in `.env` (see `.env.example`), or `railway run pnpm dev` against _production_ database vars (careful).
- Better-auth schema changes (plugins, fields): CLI needs _live_ DB to introspect. Spin throwaway postgres (`docker run -d -p 5544:5432 -e POSTGRES_PASSWORD=gen -e POSTGRES_DB=buttery postgres:16-alpine`), then `DATABASE_URL=postgresql://postgres:gen@127.0.0.1:5544/buttery pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output scripts/better-auth.sql -y`, apply SQL manually to each environment's DB (prod via postgres service's `DATABASE_PUBLIC_URL` proxy). No other migration infra exists.

## Gotchas

- pnpm 11 warns `pnpm.onlyBuiltDependencies` in package.json ignored (moved to pnpm settings); harmless, esbuild/lightningcss build scripts still work.
- Several TanStack deps pinned to `latest` in package.json (CLI default); lockfile pins actual versions.
- Use intent skills above before router/start architectural changes — no guessing patterns.
- Local port 5432 usually unrelated `core-api-postgres-1` container — NOT buttery's DB. Use `railway dev` or throwaway container on another port.
- Dev OAuth: browse http://127.0.0.1:3000, never localhost — atproto loopback redirect and session cookie bound to 127.0.0.1 (vite already binds that host).
- Railway iac secrets: `{ generator: "secret(44)", preserveExisting: true }` generates per-environment on first apply, never overwrites existing values.
- `pnpm test` exits 1 — no test files yet.
- `tsr generate` rewrites `createFileRoute()` path literals (e.g. normalizes `[.]` escapes) — don't fight it.
- Prettier enabled but make NO special effort to run — husky pre-commit hook runs
  `lint-staged` (prettier --write + eslint --fix on staged files) automatically.

## TODO: collapse TypeScript 6/7 side-by-side setup once TS 7.1 API lands

TypeScript 7.0 (native Go compiler) ships without programmatic API, so `typescript-eslint`
cannot use it until TypeScript 7.1. Per official TS 7.0 announcement, run 6 and 7
side-by-side via npm aliases in `package.json`:

- `"@typescript/native": "npm:typescript@^7.0.2"` — native `tsc` binary (v7),
  used by `pnpm typecheck`.
- `"typescript": "npm:@typescript/typescript6@^6.0.2"` — `typescript` module name resolves
  to TS 6 API for typescript-eslint, editors, other tooling; also provides `tsc6`.

**Agent instruction:** moment you notice `typescript` upgraded such that
typescript-eslint supports TS >= 7.1 (tracking: https://github.com/typescript-eslint/typescript-eslint/issues/10940),
complete this migration: replace both aliases with plain `"typescript": "^7.1.0"` (or current)
devDependency, upgrade `typescript-eslint` to version supporting it, run `pnpm install`,
verify `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass, then DELETE this entire
TODO section from AGENTS.md and update Stack section's TypeScript line.

## Next steps

- Auth wired (2026-07-23): prod DB schema applied, Railway vars set. Untested: interactive atproto callback leg (needs browser sign-in). Deploy with `railway up` when ready.
