<!-- intent-skills:start -->

## Skill Loading

Before edit files for big task:

- Run `pnpm dlx @tanstack/intent@latest list` from workspace root. See local skills.
- Skill match task → run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before change files.
- Use loaded `SKILL.md` guidance while change.
- Monorepos: work span packages → run skill check from workspace root, prefer local skill for changed package.
- Many matches: prefer most specific local skill for changed package/concern. Load extra skills only when task span many packages/concerns.

<!-- intent-skills:end -->

> When updating this file, keep this overall structure. Always update in a caveman voice.

## Working Style

- Scope to task. No adjacent refactors unless asked.
- Load skills before work in their domain: `local-dev` (dev stack), `buttery-design-system` + `docs/BRAND.md` (any UI), `accessibility-compliance` (new UI), `use-railway` (infra).
- Bash calls: no `$VAR`, `$(...)`, `KEY=value` prefixes, no complex quoting — permission analyzer can't parse, each trigger approval prompt. Need them → Write `.sh`, then `bash file.sh`.
- `git -C <dir> ...`, never `cd <dir> && git ...` (same approval-prompt reason).

## Sensitive Areas

- Generated, never hand-edit: `src/routeTree.gen.ts`, `src/db/types.ts` (kysely-codegen), `src/lexicons/**` (from `lexicons/*.json` via `pnpm lex:build`).
- `src/db/migrations/` — never edit applied migration; always add new one.
- `.railway/railway.ts` = infra source of truth. Edit it → `railway config plan` → `railway config apply`. Never hand-edit Railway dashboard state.
- `lexicons/*.json` — vendored + hand-patched for strict lex-schema 0.2.2. Read `lexicons/PATCHES.md` before touch or re-pull; CID manifest not track patches.

## Conventions Not Enforced by Tooling

- `src/server/` = server business logic (`createServerFn` + its pure domain modules), first-class as routes. `src/lib/` = shared client-safe utils. No dump server logic in `lib/`.
- UI use semantic tokens only (`bg-primary`, `text-muted-foreground`). Never raw hex or `bg-[var(--butter)]`.
- All frontend WCAG A minimum, lean AA (keyboard, focus, labels, reduced motion, touch targets). Strict AA contrast ratios not required.
- New system CLIs go in `[tools]` in `mise.toml` — not homebrew, not npm globals. Fresh clones need `mise trust`.

## Architecture Decisions

- Atproto OAuth only sign-in (better-auth + custom plugin, DID = identity, synthetic email). Records go through `@atproto/lex` codegen — `@atproto/api` removed on purpose.
- One shared Kysely instance, `getDb()` in `src/lib/db.ts`; better-auth use it too. Prefer query-builder primitives over raw `sql`. In server fns, `import` dynamic inside handler so `pg` stay out of client bundles.
- srvx host prod, NOT nitro vite plugin — nitro-nightly output self-fetch and break.
- No Twitter/X-specific meta, ever. Standards-based `og:*` only; every platform read OG. `og:url`/canonical emitted globally in `__root.tsx`, not from `seo()`.
- `typescript` (TS 6 alias, for typescript-eslint) and `@typescript/native` (TS 7, for `pnpm typecheck`) coexist on purpose. Collapse to plain TS 7.1 once [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) land.

## Runtime Gotchas

- Claude Code command sandbox block dev DB host and `localhost:3000`. Anything that connect (`db:migrate:up/down/list`, `db:codegen`, DB tests) must run via `!` in prompt or sandbox-disabled. `db:migrate:new` connect to nothing — always run direct. Verify pages via Chrome MCP, not `curl`.
- `pnpm install`/`add` fail in sandbox — run sandbox-disabled, with `CI=true`, plus `--no-frozen-lockfile` after edit package.json.
- Global element CSS MUST live in `@layer base` — unlayered rules beat Tailwind utilities. `cursor: pointer` counter-rule for Tailwind v4 preflight live there too; no remove it.
- Browse dev at `http://127.0.0.1:3000`, never `localhost` — atproto forbid `.localhost` in web client_ids, so OAuth and session cookies bind to loopback.
- Recipe ids ARE atproto rkeys (`-`, `.`, `_`, `:`, `~`, up to 512 chars). Never shape-validate them; regex reject real ids. DB existence only truth.

## Workflow Rules

- Migrations: `pnpm --filter @buttery/web db:migrate:new <snake_case_name>`, then edit generated file. **Never hand-name one** — kysely-ctl stamp `Date.now()`; hand-picked prefix drift ahead of clock, next generated file sort before applied one, Kysely reject as corrupted. Plan docs saying "prefix greater than X" wrong; run CLI.
- Right after `db:migrate:up`, run `db:codegen` so `src/db/types.ts` match schema.
- Local stack one singleton process-compose project (`pnpm dev`). Agents drive it via `pc_*` MCP tools, never ask user. Boot/teardown stay CLI-only. Never start second dev server.
- Anything DB-touching run under `railway run --service buttery -- <cmd>`. Never hardcode postgres host port — it regenerate.
- `*.db.test.ts` SKIP silent without database, so `pnpm test` stay green. Changed schema or server-fn behavior → also run `pnpm test:db`.
