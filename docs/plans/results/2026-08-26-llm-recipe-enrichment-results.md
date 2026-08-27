# Results: LLM recipe enrichment (second-opinion classifier)

Execution log for the plan at
[`../2026-08-26-llm-recipe-enrichment.md`](../2026-08-26-llm-recipe-enrichment.md). Built on
branch `claude/llm-enrichment`, which targets `claude/recipe-enrichment` rather than `main` —
the rules pipeline this extends is not merged yet (plan header).

Records what was built, how it was verified, the deliberate deviations, the two things the
plan got wrong, and — explicitly, in its own section — everything from §12.3 that no agent
could verify because it needs live LLM or PostHog access.

## Orchestration

One coordinator and six build agents over disjoint file sets in a single working tree. The
plan's §4 folder layout is already a clean dependency cut, so the only real coupling was the
type contract — the coordinator wrote that first (`llm/schema.ts`, `types.ts`'s additions, the
`@buttery/pipeline-contract` additions) and the six ran against a fixed interface rather than
against each other.

| Agent       | Plan section              | Files                                                              |
| ----------- | ------------------------- | ------------------------------------------------------------------ |
| migration   | §3                        | the one generated migration, `services/web/src/db/types.ts`        |
| merge       | §8                        | `llm/merge.ts`, `llm/merge.test.ts`                                |
| prompt      | §5.2, §6.2, §6.3          | `llm/prompt.ts`, `llm/prompt-fetch.ts` + test                      |
| capture     | §5.1, §10                 | `llm/posthog.ts`, `llm/capture.ts` + test                          |
| provider    | §6.1, §7.1                | `llm/provider.ts`, `llm/classify.ts` + test                        |
| load        | §9.1                      | `lib/load.ts`, `lib/load.db.test.ts`                               |
| coordinator | §3.4, §4, §7.2, §9.2, §11 | the contract, `llm/schema.test.ts`, `steps.ts`, `index.ts`, config |

## What was built

Everything in §1.1.

- **§3** One migration: the `llm_*` column family on `recipe_enrichment`, its claim index, the
  three-arm verdict check constraint, and the new vocabulary. Applied, rolled back, re-applied
  and codegen'd against a real database; `up → down → up` is clean.
- **§4** The `llm/` folder exactly as laid out, one file per thing a human would want to
  change. `prompt.ts` is THE PROMPT; `merge.ts` is THE POLICY.
- **§6** Provider registry (`moonshot` only), PostHog Prompt Management fetch with the
  committed prompt as fallback, and the prompt itself.
- **§7** The closed-enum zod schema and `LLM_ENRICHMENT_VERSION`, pinned by a snapshot test in
  the same idiom `classify.test.ts` uses for the rules half.
- **§8** The safety-asymmetric merge, every row of the table, 43 tests.
- **§9** `writeEnrichment` method-scoped with the content-change cascade; `writeLlmEnrichment`,
  `markLlmError`, `markLlmSkipped`, `getLlmEnrichmentState`, `claimLlmBatch`; the three new
  steps and the `enrich` → `llm-enrich` handoff.
- **§10** Manual `$ai_generation` capture with the origin-based redaction split, and one
  `llm_enrichment_disagreement` event per refused judgment.
- **§11** `.env.example`, `.railway/railway.ts` (both pipeline services), one `AGENTS.md` rule.

## Two things the plan got wrong

Both were found by building against a real database rather than by reading, and both are
recorded in the decision journal with the query that decides them.

### `cuisine` is not a new `recipe_vocab` dimension (§3.2)

The plan frames `cuisine`, `meal_type` and `spice_level` as three new dimensions and gives a
24-slug cuisine list to seed. But `1785300000000_create_recipe_rendered.ts` already seeded a
`cuisine` dimension with 33 upstream-aliased slugs from `exchange.recipe.defs#cuisine*`, and
**18 of the plan's 24 collide on slug string exactly**. Inserting all 24 would have violated
`recipe_vocab_pkey` and failed the migration on `up`.

Only the 6 genuinely absent slugs are seeded (`southern_us`, `cajun_creole`, `north_african`,
`ethiopian`, `west_african`, `eastern_european`); the other 18 already satisfy
`recipe_enrichment_label`'s FK. `meal_type` and `spice_level` are new outright. The plan's
24-slug list remains correct as what it actually is — the LLM's closed ENUM (L12) — which is a
different statement from what the table lacks. Re-run
`select slug from recipe_vocab where dimension = 'cuisine'` before assuming otherwise.

The six macro/paleo diet slugs were confirmed already present under `diet`, as the plan says.

### The merge policy hits a primary-key collision (§8 vs §9.1)

`recipe_enrichment_label`'s PK is `(recipe_id, dimension, slug)`. Plan §8 has the LLM writing a
row for a slug the rules already own — an allergen resolving a rules `unknown`, a diet
`excluded` over a rules `likely`. Plan §9.1 has `writeLlmEnrichment` deleting only
`method like 'llm:%'` rows, which leaves the rules row sitting on that PK. A plain insert takes
a **23505 on exactly the cases the safety-asymmetric policy exists for** — not the
"should be impossible" 23503 `describeWriteError` already explains.

Fixed with `on conflict (recipe_id, dimension, slug) do update` on **both** inserts:

1. **Forward** — the LLM overwriting a rules `unknown` in place, which is what "replacing the
   rules row" means in SQL. This is the plan's own §8 case.
2. **Reverse**, which the plan does not mention and which is equally real: now that the rules
   delete spares `llm:%` rows, a later rules re-run (a `CLASSIFIER_VERSION` backfill over
   unchanged content) can recompute a verdict for a slug the LLM currently owns and hit the
   same PK. `writeEnrichment`'s insert gets the same treatment. The consequence — a rules
   re-run can momentarily take a slug back from the LLM — is accepted rather than prevented,
   because `enrich` unconditionally re-enqueues `llm-enrich` after every successful write, so
   the next job re-establishes ownership.

Both directions are covered by `load.db.test.ts` cases against a real database.

## Deviations from the plan, deliberate

- **`ai@7`, not `ai@^6`** (§4). The plan says to pin `^6` and also says "let pnpm resolve it;
  do not guess" — pnpm resolved 7.0.79, so the `^6` in the prose was a stale guess rather than
  a constraint. The plan carries a dated correction note.
- **`generateText` + `Output.object`, not `generateObject`** (L5, §7.1). `generateObject` is
  `@deprecated` in `ai@7` — upstream `614599a` deprecated it at `6.0.0-beta.127` in favour of
  stable structured output on `generateText`, and its own doc comment says to switch. The plan
  predates that and is now annotated with a dated correction at both places it says otherwise.

  The migration is behaviour-preserving, and both things that could have made it not so were
  measured rather than assumed:

  - **Typing survives.** `Output.object`'s declared return widens to `JSONValue`, which reads
    as though the schema's inferred type is discarded. It is not: `result.output` types as the
    full `LlmOutput`. Confirmed by assigning it to a `number` and watching `tsc` print the
    whole inferred shape back — a check that would have passed silently had it been `any`.
  - **The error shape is identical.** A schema violation still throws `NoObjectGeneratedError`
    with the raw model text on `.text`. Checked against the mock for prose-wrapped JSON, an
    out-of-enum value and a flat refusal; all three threw exactly that with the text intact. So
    `classify.ts`'s catch is unchanged and `$ai_error` still carries what the model said.

  `classify.test.ts` passed all 13 cases across the migration without a single assertion
  changing, because it was written against `classifyWithLlm`'s contract rather than the SDK's.

- **No `mode: 'json'` fallback** (§7.1). `mode` does not exist on either function in `ai@7`;
  the schema-constrained strategy it used to name is what `Output.object` IS. There was
  nothing to fall back to, so nothing was built.
- **`prompt-fetch.ts` uses REST, not posthog-node's `Prompts` client** (§6.2). The installed
  `posthog-node@5.49.1` ships no prompt API — zero hits for "prompt" across its `.d.ts` files.
  §6.2's REST fallback is therefore the only path, and it is the one implemented. Its response
  shape is marked `UNVERIFIED-AGAINST-LIVE-POSTHOG` in the code; an unrecognised shape falls
  back rather than crashing.
- **`llm-enrich` re-derives the rules labels** rather than reading `recipe_enrichment_label`
  back. Sound because the step first requires `status='ok'`, `input_hash` equal to the current
  fingerprint, **and** `classifier_version` equal to the deployed `CLASSIFIER_VERSION`; under
  those three, `classify()` being pure means the re-derived labels are the stored rows. That
  third check is not in the plan and is load-bearing — without it the merge would reason about
  labels that are not in the table.
- **The macro-diet confidence ceiling (≤ 0.6, §6.3) is not re-clamped in `merge.ts`.** The
  prompt owns it and the judge evals grade it; clamping in the merge would hide an
  over-confident model behind a constant instead of surfacing it.
- **`markLlmSkipped` does not stamp `llm_version`.** §3.1 wants a skipped row "cheap to reset
  by claiming `llm_version < current`", which only works if the skip leaves the column alone.

## Verification

Everything below was actually run, not read.

| Check                                       | Result                                    |
| ------------------------------------------- | ----------------------------------------- |
| `pnpm --filter @buttery/pipeline test`      | **225 passed**, 15 files (unit + db)      |
| `pnpm --filter @buttery/pipeline typecheck` | clean                                     |
| `pnpm --filter @buttery/web typecheck`      | clean (against regenerated codegen types) |
| `pnpm lint`                                 | 0 errors (3 pre-existing React warnings)  |
| migration `up → down → up` + `db:codegen`   | clean, verified with `psql`               |

Test counts by §12.1 bullet: merge 43, capture 25, schema 13, classify 13, prompt-fetch 10,
`load.db.test.ts` 32 (including every new LLM case), the `llm-enrich` gate step test 4.

**The lazy-boot property (§4) was measured, and the first measurement was wrong.** A probe over
the CJS require cache reported that booting the workflow loaded none of `ai`, `zod`,
`posthog-node` or `@ai-sdk/openai-compatible`. A negative control — import `zod` on purpose,
ask the same probe — reported `DETECTED NOTHING`: the probe was blind, because a pure-ESM
package never populates that cache. Rebuilt on `module.registerHooks`, the control correctly
detected `zod` and the real boot graph came back clean over 333 modules.

The blind probe was masking a real defect: `steps.ts` imported `LLM_ENRICHMENT_VERSION`
statically from `llm/schema.ts`, which imports `zod` at its top — so the server's boot _was_
paying for it, contrary to §4. That import is now lazy inside the two steps that need it, and
no `llm/` module is imported at `steps.ts`'s module scope at all.

**No live Moonshot call and no live PostHog call was made or attempted, anywhere** (§12.2).
There are no keys in this environment. Everything model-shaped runs through `ai/test`'s
`MockLanguageModelV4` and fixture JSON; everything PostHog-shaped through injected fakes. The
`llm-enrich` gate test proves "never constructs a provider" without a spy: it deletes
`LLM_ENRICHMENT_MODEL`, `MOONSHOT_API_KEY` and `LLM_ENRICHMENT_PROVIDER` from the environment,
so `resolveProvider()` would throw on sight if the gate ever stopped short-circuiting.

## NOT verified by agents — needs a human with keys (§12.3)

Nothing below has been run. Every item needs live LLM or PostHog access that no implementing
agent had.

1. **A real generation.** Local stack, `LLM_ENRICHMENT_ENABLED=true`, real `MOONSHOT_API_KEY`:
   save the fish-sauce pad thai, watch `llm-enrich` on the Bull Board, confirm the dev panel
   shows `llm:` labels alongside `rules@2` and that cuisine/meal_type/spice rows are present.
   **`LLM_ENRICHMENT_MODEL` has never been validated against Moonshot** — no code has a default,
   deliberately, so a wrong id fails loudly at first run. `kimi-k2-0905-preview` is what the
   Railway config carries; verify it against platform.moonshot.ai before the first deploy.
2. **`$ai_generation` in PostHog** — visible in Traces/Generations with tokens and eventually
   cost, and a **local-origin** recipe's generation showing no input/output content (L10). The
   redaction logic is unit-tested; that it lands correctly in PostHog is not.
3. **The prompt fetch against live PostHog.** The REST response shape in `prompt-fetch.ts` is a
   documented assumption. If it is wrong, every recipe silently runs on the committed fallback
   with `llm_prompt_version = null` — which is a query, not a mystery, and is the first thing
   to check after the flag turns on.
4. **The flag path.** Override unset, `POSTHOG_ENABLED=true` against the prod flag at 0% →
   `skipped`; at 100% → runs.
5. **`llm-backfill` end to end** — `POST /jobs/recipe-enrichment {"name":"llm-backfill","data":{"limit":20}}`,
   fan-out, report, sane `remaining`.
6. **All of §5** — the entire PostHog-side setup (flag, prompt, personal API key, evaluations,
   judge provider key, dataset, dashboard) is untouched. §5.6's checklist is the running order.

## Numbers to record after the canary (§13)

Left blank on purpose — these decide whether the safety-asymmetric policy loosens, the flag
ratchets, or the prompt goes back to the shop.

| Metric                         | First week |
| ------------------------------ | ---------- |
| generations/day                | —          |
| cost/day                       | —          |
| schema-reject rate             | —          |
| disagreement rate by dimension | —          |
