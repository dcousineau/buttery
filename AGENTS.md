<!-- intent-skills:start -->

## Skill Loading

Before edit files for big task:

- Run `pnpm dlx @tanstack/intent@latest list` from workspace root. See local skills.
- Skill match task → run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before change files.
- Use loaded `SKILL.md` guidance while change.
- Monorepos: work span packages → run skill check from workspace root, prefer local skill for changed package.
- Many matches: prefer most specific local skill for changed package/concern. Load extra skills only when task span many packages/concerns.

<!-- intent-skills:end -->

> When updating this file, keep this overall structure. Always update in a caveman voice

## Working Style

- Scope to task. No adjacent refactors unless asked.
- Load skills before work in their domain: `local-dev` (dev stack), `buttery-design-system` + `docs/BRAND.md` (any UI), `accessibility-compliance` (new UI), `use-railway` (infra).
- Bash calls: no `$VAR`, `$(...)`, `KEY=value` prefixes, no complex quoting — permission analyzer can't parse, each trigger approval prompt. Need them → Write `.sh`, then `bash file.sh`.
- `git -C <dir> ...`, never `cd <dir> && git ...` (same approval-prompt reason).
- Prefer native CSS over JS listeners. Shared behavior live in shared `ui/` component, not call site.

## Sensitive Areas

- Generated, never hand-edit: `src/routeTree.gen.ts`, `src/db/types.ts` (kysely-codegen), `src/lexicons/**` (from `lexicons/*.json` via `pnpm lex:build`).
- Generated, never hand-edit: `services/web/public/fonts/**` + `services/web/src/fonts.css`, `services/docs/static/fonts/**` + `services/docs/src/css/fonts.css`. Brand webfont vendored local, no Google CDN. Change weight or refresh → edit + run `scripts/update-fonts.sh`.
- Generated, never hand-edit: `services/web/src/lib/grocery/lexicon.json` (from Open Food Facts taxonomy via `node scripts/build-food-lexicon.ts`). Edit `scripts/food-aisle-map.ts`, `scripts/food-staples.ts`, `scripts/food-synonyms.ts` instead, then re-run script. Bump `SOURCE_COMMIT` in build script + regenerated JSON land same commit. ODbL derived data — `lexicon.LICENSE.md` beside it travel with it.
- `src/db/migrations/` — never edit applied migration; always add new one.
- `.railway/railway.ts` = infra source of truth. Edit it → `railway config plan` → `railway config apply`. Never hand-edit Railway dashboard state.
- `lexicons/*.json` — vendored + hand-patched for strict lex-schema 0.2.2. Read `lexicons/PATCHES.md` before touch or re-pull; CID manifest not track patches.

## Conventions Not Enforced by Tooling

- `src/server/` = server business logic (`createServerFn` + its pure domain modules), first-class as routes. `src/lib/` = shared client-safe utils. No dump server logic in `lib/`.
- UI use semantic tokens only (`bg-primary`, `text-muted-foreground`). Never raw hex or `bg-[var(--butter)]`.
- All frontend WCAG A minimum, lean AA (keyboard, focus, labels, reduced motion, touch targets). Strict AA contrast ratios not required.
- Lint = `oxlint`, format = `oxfmt`. No ESLint, no Prettier.
- New system CLIs go in `[tools]` in `mise.toml` — not homebrew, not npm globals. Fresh clones need `mise trust`.
- `package.json` is the only place tool versions live: node in `devEngines.runtime`, pnpm in `packageManager`. mise and `actions/setup-node` both read them. Never re-pin either in `mise.toml`, and treat `.nvmrc` as vestigial (nothing reads it).

## Architecture Decisions

- Atproto OAuth only sign-in (better-auth + custom plugin, DID = identity, synthetic email). Records go through `@atproto/lex` codegen — `@atproto/api` removed on purpose.
- One shared Kysely instance, `getDb()` in `src/lib/db.ts`; better-auth use it too. Prefer query-builder primitives over raw `sql`. In server fns, `import` dynamic inside handler so `pg` stay out of client bundles.
- srvx host prod, NOT nitro vite plugin — nitro-nightly output self-fetch and break.
- No Twitter/X-specific meta, ever. Standards-based `og:*` only; every platform read OG. `og:url`/canonical emitted globally in `__root.tsx`, not from `seo()`.
- TS 7 remove `baseUrl` (TS5102) — `services/docs` inline `@docusaurus/tsconfig` instead of extend it, because child config no can unset inherited option.

## Runtime Gotchas

- Claude Code command sandbox block dev DB host and `localhost:3000`. Anything that connect (`db:migrate:up/down/list`, `db:codegen`, DB tests) must run via `!` in prompt or sandbox-disabled. `db:migrate:new` connect to nothing — always run direct. Verify pages via Chrome MCP, not `curl`.
- `pnpm install`/`add` fail in sandbox — run sandbox-disabled, with `CI=true`, plus `--no-frozen-lockfile` after edit package.json.
- Cloud session (Claude Code on web): read `docs/CLAUDE_CLOUD.md` first — it list every fix session need.
- Cloud session, `node --version` say v22 (not v26) → setup script no finish. Fix self, no wait: `ln -sf "$HOME/.local/share/mise/shims"/* "$HOME/.local/bin/"` (that dir already first on PATH). Stopgap = wrap command in `bash -lc '…'`. Same break hit `git commit` (husky hook).
- Node older than 26 → pnpm refuse install (`devEngines.runtime`). Fix = `mise install`, no bypass. Bypass need it anyway: use transient `--runtime-on-fail=ignore`. NEVER `--config.runtime-on-fail=ignore` — that one write `onFail: "ignore"` into package.json.
- Global element CSS MUST live in `@layer base` — unlayered rules beat Tailwind utilities. `cursor: pointer` counter-rule for Tailwind v4 preflight live there too; no remove it.
- Browse dev at `http://127.0.0.1:3000`, never `localhost` — atproto forbid `.localhost` in web client_ids, so OAuth and session cookies bind to loopback.
- Type-aware oxlint need built lexicons. Fresh clone or CI: `pnpm --filter @buttery/lexicons build` before `pnpm lint`, else `src/generated` missing → every lexicon import `error`-typed → hundreds of phantom `no-unsafe-*`.
- Recipe ids ARE atproto rkeys (`-`, `.`, `_`, `:`, `~`, up to 512 chars). Never shape-validate them; regex reject real ids. DB existence only truth.

## Workflow Rules

- Migrations: `pnpm --filter @buttery/web db:migrate:new <snake_case_name>`, then edit generated file. **Never hand-name one** — kysely-ctl stamp `Date.now()`; hand-picked prefix drift ahead of clock, next generated file sort before applied one, Kysely reject as corrupted. Plan docs saying "prefix greater than X" wrong; run CLI.
- Right after `db:migrate:up`, run `db:codegen` so `src/db/types.ts` match schema.
- Local stack one singleton process-compose project — never start second dev server. Load `local-dev` skill before boot, tear down, restart, or inspect it; skill own the how (CLI vs `pc_*` MCP tools, config-reload traps, log reading).
- DB connection = `DATABASE_URL` in per-service `.env` (`services/web/.env`, `services/atproto-cron-sync/.env`), fixed port from repo-root `docker-compose.yml` (55432). Each service load own file — `kysely.config.ts`, `vite.config.ts`, cron `src/config.ts` + `vitest.config.ts` — no wrapper. `scripts/dev/bootstrap-env.mjs` create missing ones from `.env.example`. Only web `pnpm test:db` still wrap `railway run --service buttery --`.
- Cron sync target network = `services/atproto-cron-sync/.env`, nothing else. Default live atmosphere; local dev-env need `SYNC_PDS_URL=http://localhost:2583` + `ATPROTO_PLC_URL=http://localhost:2582` in that file (dev-env ship no relay; its PDS reject unauthenticated `listReposByCollection`). Same either way: `pnpm --filter @buttery/atproto-cron-sync sync:once`, or process-compose `atproto-cron-sync` (disabled one-shot, start by hand). Sweep idempotent — re-run after each publish.
- New token or form state → update `docs/BRAND.md` + `.agents/skills/buttery-design-system/**`, then push `/design-sync`. Local bundle is source; leave no orphan remote file.
- `*.db.test.ts` SKIP silent without database, so `pnpm test` stay green. Changed schema or server-fn behavior → also run `pnpm test:db`.
