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
- Generated, never hand-edit: `packages/food/src/lexicon.json` AND `packages/food/src/traits.json` (both from Open Food Facts taxonomy via `node scripts/build-food-lexicon.ts`, one run write both). Edit `scripts/food-aisle-map.ts`, `scripts/food-staples.ts`, `scripts/food-synonyms.ts`, `scripts/food-allergens.ts`, `scripts/food-tags.ts` instead, then re-run script. Bump `SOURCE_COMMIT` in build script + regenerated JSON land same commit. ODbL derived data — `lexicon.LICENSE.md` beside them travel with them. `lexicon.json` ship to client (gzip budget assert in script); `traits.json` SERVER ONLY — never import it from anything client bundle reach.
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
- `npx <tool>` FAIL in cloud session — npm reject node `v26.8.0-alpha...` against `devEngines.runtime: ^26`. Use `./node_modules/.bin/<tool>` from repo root instead (oxfmt, oxlint, coherence, vitest all there). Cost several agents a whole tool each.
- Cloud session, `node --version` say v22 (not v26) → setup script no finish. Fix self, no wait: `ln -sf "$HOME/.local/share/mise/shims"/* "$HOME/.local/bin/"` (that dir already first on PATH). Stopgap = wrap command in `bash -lc '…'`. Same break hit `git commit` (husky hook).
- Node older than 26 → pnpm refuse install (`devEngines.runtime`). Fix = `mise install`, no bypass. Bypass need it anyway: use transient `--runtime-on-fail=ignore`. NEVER `--config.runtime-on-fail=ignore` — that one write `onFail: "ignore"` into package.json.
- Global element CSS MUST live in `@layer base` — unlayered rules beat Tailwind utilities. `cursor: pointer` counter-rule for Tailwind v4 preflight live there too; no remove it.
- Browse dev at `http://127.0.0.1:3000`, never `localhost` — atproto forbid `.localhost` in web client_ids, so OAuth and session cookies bind to loopback.
- Type-aware oxlint need built lexicons. Fresh clone or CI: `pnpm --filter @buttery/lexicons build` before `pnpm lint`, else `src/generated` missing → every lexicon import `error`-typed → hundreds of phantom `no-unsafe-*`.
- Recipe ids ARE atproto rkeys (`-`, `.`, `_`, `:`, `~`, up to 512 chars). Never shape-validate them; regex reject real ids. DB existence only truth.

## Workflow Rules

- Migrations: `pnpm --filter @buttery/web db:migrate:new <snake_case_name>`, then edit generated file. **Never hand-name one** — kysely-ctl stamp `Date.now()`; hand-picked prefix drift ahead of clock, next generated file sort before applied one, Kysely reject as corrupted. Plan docs saying "prefix greater than X" wrong; run CLI.
- Right after `db:migrate:up`, run `db:codegen` so `src/db/types.ts` match schema.
- NO `comment on table/column/constraint` prose in migration. Every agent read whole repo — types, plan docs, classifier code already say it, and codegen copy DB comment into `src/db/types.ts`, so schema comment become second copy that drift. Only allowed DB comment: expected JSON shape of a `json`/`jsonb` column. Invariant belong in TS comment beside code that enforce it, or doc file — not in schema.
- Local stack one singleton process-compose project — never start second dev server. Load `local-dev` skill before boot, tear down, restart, or inspect it; skill own the how (CLI vs `pc_*` MCP tools, config-reload traps, log reading).
- DB connection = `DATABASE_URL` in per-service `.env` (`services/web/.env`, `services/pipeline/.env`), fixed port from repo-root `docker-compose.yml` (55432). Each service load own file — `kysely.config.ts`, `vite.config.ts`, pipeline `src/env.ts` + `vitest.config.ts` — no wrapper. `scripts/dev/bootstrap-env.mjs` create missing ones from `.env.example`. Only web `pnpm test:db` still wrap `railway run --service buttery --`.
- Sync target network = `services/pipeline/.env`, nothing else. Default now LOCAL dev-env (`ATPROTO_PLC_URL=http://localhost:2582` + `SYNC_PDS_URL=http://localhost:2583`) — match `services/web/.env`, which publish to same PDS; two half must agree or sweep never see what app just publish. Live atmosphere sit commented under them — swap to sweep real network. `SYNC_PDS_URL` use PDS `listRepos` because dev-env ship no relay and its PDS reject unauthenticated `listReposByCollection`; it also make sweep PARTIAL — no missing-repo reconcile. Prod no read this file: `.railway/railway.ts` set `RELAY_URL`, leave other two unset. Same file whoever drive sweep. Sweep idempotent — re-run after each publish. Three way run it: `pnpm --filter @buttery/pipeline sync:trigger`, process-compose `atproto-sync` (disabled one-shot, start by hand), or through queue: `curl -X POST http://127.0.0.1:3002/jobs/atproto-sync -d '{}' -H 'content-type: application/json'`. All three take same fleet-wide Redis lock — second one SKIP, no fail.
- No Railway cron service any more, and no `@buttery/atproto-cron-sync` package — sweep source live in `services/pipeline/src/workflows/atproto-sync/`. Schedule live in BullMQ, reconciled at server boot from `ATPROTO_SYNC_SCHEDULE`. Blank locally on purpose — laptop no sweep live atmosphere in background.
- New background job = new FOLDER in `services/pipeline/src/queues/` with `index.ts` that is Fastify plugin. `app.ts` autoload it — file existing IS the registration, no registry to edit. Always set `removeOnComplete`/`removeOnFail` — BullMQ keep finished jobs forever otherwise, and fan-out make one job per item.
- NO workflow engine any more. Three BullMQ primitives only: `Queue`, `Worker`, `Flow`. `fastify.bullmq.queue({name, description, jobs, defaultJob, ...})` register queue; `fastify.bullmq.worker(name, processor)` register ONE processor that `switch (job.name)`. Handler get real `Job` — use `job.data`, `job.log()`, `job.updateProgress()`, `job.getChildrenValues()`. No `StepContext`, no `ctx.*`. BullMQ docs now describe this code.
- Fan out with `fastify.bullmq.flow.add({name, queueName, data, children})` — one atomic FlowProducer call. Every node need BOTH `name` and `queueName`. Children MUST set `ignoreDependencyOnFailure: true` EXPLICIT — not a BullMQ default, old kernel used set it for you. Without it one dead child fail the parent. Parent read children with `job.getChildrenValues()` + `job.getIgnoredChildrenFailures()`. Parent wait in `waiting-children`, hold no worker slot.
- Job options NOT automatic any more. Old kernel apply step's `jobOptions` at every enqueue; `Queue` is just `Queue` now. Pass options EXPLICIT at every `queue.add`/`flow.add`. Export them as named const next to handler. `POST /jobs/:queue` can't reach them and fall back to `defaultJobOptions` — deliberate.
- Hand work to ANOTHER queue = `fastify.bullmq.get(name)` then `.queue.add(job, data, opts)`. Look up explicit and THROW when registration missing — typo must fail at call, not vanish. Never make it flow child: flow child make caller's parent wait on it, and `atproto-sync` finalize hold hour-TTL sweep lock whole time, so next scheduled sweep SKIP. Hand work to OWN queue = just `queue.add` on queue you already registered — no lookup, it was never cross-queue thing.
- Two workflows live: `atproto-sync` (sweep network into recipe index) and `recipe-enrichment` (derive allergen + diet label per recipe — steps `enrich`, `llm-enrich`, both in `index.ts`). Enrichment NEVER write `recipe.suitable_for_diet`, `recipe.calories` or `*_content` — author declare those, pipeline own `recipe_enrichment` + `recipe_enrichment_label`, both stay Buttery-only and never reach a PDS. Writer mark row `status='stale'` in own transaction, THEN enqueue best-effort: row is durable signal, job only latency. Backfill is a CLI script now (`pnpm --filter @buttery/pipeline backfill`), not a step — no schedule, no boot re-enqueue.
- `recipe-enrichment` have SECOND label provider: `llm-enrich` step run after every good rules write, ask OpenRouter through Vercel AI SDK. FAIL-CLOSED — env var `LLM_ENRICHMENT_ENABLED` is whole gate (true/1/yes/on, anything else including unset mean NO call). NOT PostHog flag any more, and NOT declared in `.railway/railway.ts` — operator toggle it in Railway UI, apply must not clobber it. Merge is safety-asymmetric: LLM may escalate allergen or fill absence, may NEVER talk down rules `contains`/`may_contain` or overturn rules `excluded` — refused ones become PostHog disagreement events, not labels. Two provider own disjoint rows in one table by `method` prefix (`rules@N` vs `llm:%`); each writer delete only own scope, except content change which wipe both.
- ALL food classification live in `packages/food`, both half. Rules half = `src/classify.ts` + `src/classifiers/`. LLM half = `src/llm/` (prompt id + fallback text, closed slug set, `llmOutputSchema`, `LLM_ENRICHMENT_VERSION`, `llmMethod`, `buildRecipeJson`/`compilePrompt`), reach only as `@buttery/food/llm` — NEVER re-export it from the package barrel, `zod` is optional peer dep and barrel go in client bundle. `services/pipeline` keep only what have I/O or AI SDK: prompt fetch, `generateText`, merge, load, capture.
- Prompt live TWO place on purpose: PostHog Prompt Management (`recipe-llm-enrichment`, label `production`) is fast path, `packages/food/src/llm/prompt.ts` is fallback AND the reviewable record. Edit in PostHog to iterate; when iteration settle, COPY IT BACK to `prompt.ts` next PR. Prompt wording change no bump `LLM_ENRICHMENT_VERSION` — slug set or schema shape change MUST.
- See EXACT prompt pipeline would send for a recipe: `pnpm --filter @buttery/pipeline prompt <recipeId> [<recipeId>...] [--posthog] [--json]`. Re-derive rules label, compile prompt, print. Never call model, never write row. Prompt go STDOUT, everything else STDERR — `> case.txt` give clean eval-set case. This is how build eval set; no hand-assemble prompt, it drift.
- No throttle producer. Fan out everything, queue is buffer. Cap in-flight with workflow `globalConcurrency` — BullMQ enforce it in Redis fleet-wide, survive autoscaler moving replica count. Worker `concurrency` only bound one process.
- Long workflow that also have schedule need overlap guard. `atproto-sync` take Redis mutex (`lock.ts`) in first step, release in last — span whole graph. Loser SKIP (`{status:"skipped"}`), no fail. No heartbeat (holder is graph, no process), so TTL = schedule period.
- Step that open durable row must close it in own try/catch — no kernel hook. Dead run else leave `atproto_sync_run` say `running` forever.
- New token or form state → update `docs/BRAND.md` + `.agents/skills/buttery-design-system/**`, then push `/design-sync`. Local bundle is source; leave no orphan remote file.
- `pnpm --filter @buttery/pipeline trigger <queue> [--job=name] [--flags]` only ENQUEUE job then exit — it run nothing itself, need server + worker already up, watch it in Bull Board. Replaced `run:once`, which used run whole graph in-process through second execution engine. One engine now.
- `*.db.test.ts` SKIP silent without database, so `pnpm test` stay green. Changed schema or server-fn behavior → also run `pnpm test:db`.
