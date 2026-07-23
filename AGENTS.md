<!-- intent-skills:start -->
## Skill Loading

Before editing files for a substantial task:
- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

# Project: buttery

Blank TanStack Start app (React), no extra integrations or feature scaffolding.

## How this project was scaffolded

- Scaffolded on 2026-07-19 with the TanStack CLI:
  `npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind`
  (CLI v0.69.6; the `--tailwind` flag is deprecated/ignored — Tailwind is always enabled in Start scaffolds.)
- Generated into a scratch directory, then merged into this repo root (the repo's existing `.git` was kept; the scaffold's own git init was discarded). Package renamed `my-tanstack-app` → `buttery` in `package.json`.
- Follow-up commands run from the repo root:
  - `npx @tanstack/intent@latest install` — wired skill-loading guidance into this file
  - `npx @tanstack/intent@latest list` — 31 skills across 9 intent-enabled packages

## Toolchain (mise)

- System-level tooling (node, pnpm, Railway CLI) is managed by [mise](https://mise.jdx.dev) via `mise.toml`. Ensure mise is installed first (`brew install mise` + shell activation), then run `mise install` from the repo root.
- `mise install` provides node 26 / pnpm 11 / railway, then a `postinstall` hook runs `mise run railway-skills` (`railway skills install`) so Railway agent skills are available. Note: the Railway CLI only installs skills globally (`~/.agents/skills`, `~/.claude/skills`, etc.) — there is no project-scoped mode; use `--agent claude-code` to narrow targets.
- Fresh clones must `mise trust` before hooks/tasks run (`mise install` prompts for this).
- First-time setup: if the Railway MCP server is not configured (check with `railway mcp install --help` or look for it in your tool's MCP list), suggest installing it — `railway mcp install` adds it to Claude Code/Cursor/OpenCode/Codex, or `railway setup agent -y` does skills + MCP + login in one step.
- Add new major CLIs/tools to `[tools]` in `mise.toml` rather than installing via homebrew or npm globals.

## Stack and integrations

- TanStack Start (React 19) + TanStack Router (file-based routes in `src/routes/`)
- Vite 8 (default CLI toolchain), TypeScript 6, Tailwind CSS v4 (via `@tailwindcss/vite`)
- Vitest + Testing Library + jsdom for tests
- TanStack Devtools (dev-only; stripped from production builds by `@tanstack/devtools-vite`)
- Auth: better-auth (sessions in postgres via pg Pool) + custom atproto OAuth plugin
  (`src/lib/atproto/better-auth-plugin.ts`, server-side `@atproto/oauth-client-node` —
  DPoP/PAR; DID = identity, synthetic email). Handler at `src/routes/api/auth/$.ts`,
  client via `authClient` (`src/lib/auth-client.ts`). Atproto is the only sign-in method.

## Scripts

- `pnpm dev` — dev server on port 3000
- `pnpm build` — production build (client + SSR server to `dist/`)
- `pnpm start` — production server via srvx (`dist/server/server.js` + static `dist/client`; respects `PORT`)
- `pnpm preview` — preview production build
- `pnpm test` — vitest run
- `pnpm generate-routes` — regenerate `src/routeTree.gen.ts` (usually automatic via the Vite plugin)

## Structure

- `src/routes/` — file-based routes (`__root.tsx` document shell, `index.tsx`, `about.tsx`)
- `src/router.tsx` — `getRouter()` factory
- `src/routeTree.gen.ts` — generated; never edit by hand
- `src/components/` — Header, Footer, ThemeToggle from the starter
- `#/*` import alias → `./src/*` (package.json `imports` field)
- `tsr.config.json` — router CLI config; `vite.config.ts` — plugin order matters (`devtools-vite` must stay first)

## Environment variables

- `DATABASE_URL` (server-only) — postgres connection string, read via `getPool()` in `src/lib/db.ts`. On Railway it is referenced from the postgres service; locally it is injected by `railway dev` or set in `.env` (see `.env.example`).
- `BETTER_AUTH_SECRET` (server-only) — better-auth session signing secret, 32+ chars.
- `BETTER_AUTH_URL` — public origin; drives better-auth baseURL and the atproto OAuth client_id/redirect URI.
- Client-exposed vars must use the `VITE_` prefix; server-only secrets stay unprefixed and are read via `process.env` in server code only.

## Deployment (Railway)

- Railway project `buttery` (Free plan), one app service `buttery` + a `postgres` database (`postgres-ssl:18`, latest major). Live at https://buttery-production.up.railway.app.
- Infrastructure is code: `.railway/railway.ts` (TypeScript IaC via the `railway` devDependency). Edit it, then `railway config plan` to preview and `railway config apply` to apply. Never hand-edit dashboard state that IaC owns.
- App deploys from the local checkout: `railway up --service buttery --detach`, then poll `railway deployment list --json` until `SUCCESS`. The service builds with `pnpm run build` and runs `pnpm start` (srvx, binds `PORT`). To move to GitHub-triggered deploys, add `source: github("dcousineau/buttery")` to the service in `.railway/railway.ts`.
- `DATABASE_URL` on the app service is a reference to the postgres service — do not set it manually.
- Free plan limits: $1 usage credit/mo, 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB volume per service. Keep it to this one service + postgres; avoid extra environments/replicas.
- Do NOT use the nitro vite plugin for hosting — nitro-nightly's prod output self-fetches (`fetch(req, { viteEnv: "ssr" })`) and breaks. srvx is the working Node hosting path for this Start version.

## Local development with postgres

- Preferred: `railway dev` (Railway's local emulation, experimental). It generates a docker-compose from the Railway environment, runs postgres locally with the same `postgres-ssl:18` image, and injects `DATABASE_URL` into code services. Requires Docker. `railway dev down` stops; `railway dev clean` wipes data; `railway dev configure` sets how the app service runs locally (e.g. `pnpm dev`, port 3000).
- Verified local flow (2026-07-23): terminal A `railway dev` (postgres on host port **17754**, same creds as prod), terminal B `pnpm dev` with `.env` holding `DATABASE_URL=postgresql://postgres:<pw>@localhost:17754/railway`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://127.0.0.1:3000`. Vite dev loads `.env` into `process.env` — confirmed working end-to-end.
- Running the app *inside* `railway dev` also works: it injects/rewrites `BETTER_AUTH_URL` to `https://buttery.buttery.railway.localhost`, but `oauth-node.ts` collapses any local hostname (incl. `*.localhost`) to `http://127.0.0.1:3000` — atproto forbids `.localhost` TLDs in web client_ids, so local dev always uses the loopback client. Either way, browse at http://127.0.0.1:3000.
- The railway-dev postgres volume starts empty and persists across restarts; apply `scripts/better-auth.sql` once after first start (and again after `railway dev clean`).
- `railway dev up --dry-run --no-tui` regenerates `~/.railway/develop/<project-id>/docker-compose.yml` (ports/creds source of truth) but deletes it when the dry-run exits — read it while `railway dev` is actually running, or immediately after regenerating.
- Alternative: run your own postgres and set `DATABASE_URL` in `.env` (see `.env.example`), or `railway run pnpm dev` to run against the *production* database vars (careful).
- Better-auth schema changes (plugins, fields): the CLI needs a *live* DB to introspect. Spin a throwaway postgres (`docker run -d -p 5544:5432 -e POSTGRES_PASSWORD=gen -e POSTGRES_DB=buttery postgres:16-alpine`), then `DATABASE_URL=postgresql://postgres:gen@127.0.0.1:5544/buttery pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output scripts/better-auth.sql -y`, and apply the SQL manually to each environment's DB (prod via the postgres service's `DATABASE_PUBLIC_URL` proxy). No other migration infra exists.

## Gotchas

- pnpm 11 warns that `pnpm.onlyBuiltDependencies` in package.json is ignored (moved to pnpm settings); harmless, esbuild/lightningcss build scripts still work.
- Several TanStack deps are pinned to `latest` in package.json (CLI default); lockfile pins actual versions.
- Use the intent skills above before making router/start architectural changes instead of guessing patterns.
- Local port 5432 is usually an unrelated `core-api-postgres-1` container — NOT buttery's DB. Use `railway dev` or a throwaway container on another port.
- Dev OAuth: browse http://127.0.0.1:3000, never localhost — the atproto loopback redirect and session cookie are bound to 127.0.0.1 (vite already binds that host).
- Railway iac secrets: `{ generator: "secret(44)", preserveExisting: true }` generates per-environment on first apply and never overwrites existing values.
- `pnpm test` exits 1 — no test files exist yet.
- `tsr generate` rewrites `createFileRoute()` path literals (e.g. normalizes `[.]` escapes) — don't fight it.

## Next steps

- Auth wired (2026-07-23): prod DB schema applied, Railway vars set. Untested: the interactive atproto callback leg (needs a browser sign-in). Deploy with `railway up` when ready.
