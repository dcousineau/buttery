import { UnrecoverableError } from "bullmq";
import { contentFingerprint } from "@buttery/recipe-schemas/normalize";
import {
  BACKFILL_REPORT_STEP,
  BACKFILL_STEP,
  ENRICH_STEP,
  type EnrichPayload,
  LLM_BACKFILL_REPORT_STEP,
  LLM_BACKFILL_STEP,
  LLM_ENRICH_STEP,
  llmEnrichJobId,
  type LlmEnrichPayload,
  RECIPE_ENRICHMENT_QUEUE,
} from "@buttery/pipeline-contract";
import type { StepSpec } from "#/workflows/define.ts";
import { log } from "#/log.ts";
import { getPool } from "#/workflows/recipe-enrichment/lib/db.ts";
import {
  buildClassifierLines,
  claimBatch,
  DEFAULT_BACKFILL_LIMIT,
  describeWriteError,
  getEnrichmentState,
  loadRecipe,
  markError,
  writeEnrichment,
} from "#/workflows/recipe-enrichment/lib/load.ts";
// `classify.ts` is the classifier agent's module, built in parallel against
// `types.ts`'s `ClassifierInput` / `Label` contract — see the plan §8 and this
// folder's module doc. `lib/load.ts` deliberately does not depend on it (see
// that file's doc); this is the one place in the workflow that does, because
// `enrich` is the one step that actually has to run a classifier.
import { CLASSIFIER_VERSION, classify } from "#/workflows/recipe-enrichment/classify.ts";
import type { BackfillPayload, BackfillReportPayload, LlmBackfillPayload } from "#/workflows/recipe-enrichment/types.ts";
// NOTHING from `llm/` is imported at module scope, including the things that
// look like plain constants. `LLM_ENRICHMENT_VERSION` is an integer, but it
// lives in `llm/schema.ts`, and that module imports `zod` at its top — so a
// static import of the constant drags the dependency in behind it, and the
// server's boot and `run:once` would both pay for it (plan §4: "run:once boots
// without importing any of them eagerly"). Every `llm/` import in this file is
// therefore an `await import(...)` inside the step that needs it.

/**
 * The six steps and the graph between them (plan §7, and the llm plan §9.2):
 *
 *     enrich ──enqueues──▶ llm-enrich            one recipe — the entry step
 *     backfill     ──fans out──▶ enrich × N     ──▶ backfill-report
 *     llm-backfill ──fans out──▶ llm-enrich × N ──▶ llm-backfill-report
 *
 * Two providers, one queue, one table, disjoint rows: the rules trio writes
 * `method = 'rules@N'` labels, the LLM trio writes `llm:%` ones, and each
 * writer's delete is scoped to its own (L9, `lib/load.ts`). The bottom row is
 * the top row's twin in every respect except which columns it reads — see the
 * LLM section at the bottom of this file.
 *
 * `enrich` is reachable two ways: directly, from a trigger (`ctx.enqueue` from
 * `atproto-sync`'s `sync-repo`, or the web app's write path — plan §9), and as
 * a `backfill` child. `backfill` claims a bounded batch of recipes whose
 * `recipe_enrichment` row is missing, stale, or behind the current
 * `CLASSIFIER_VERSION`, and fans them out as `enrich` children under a
 * `backfill-report` parent — one atomic `flow()` call, so there is no window
 * where half the batch is submitted.
 *
 * No overlap lock (D14): unlike `atproto-sync`, this workflow has no schedule
 * to guard the next firing of, and BullMQ already refuses to run the same job
 * twice — `enrichJobId` (`@buttery/pipeline-contract`) makes two triggers for
 * one recipe collapse into one job instead of racing.
 */

// --- enrich (entry) --------------------------------------------------------

function parseEnrichPayload(payload: unknown): EnrichPayload {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
  if (!recipeId) {
    // Retrying a malformed payload three times is three wasted slots — fail
    // now, the same idiom `sync-repo` uses for a job with no `did`.
    throw new UnrecoverableError("enrich job has no recipeId");
  }
  return { recipeId, force: raw.force === true };
}

/**
 * Classify one recipe. See `lib/load.ts` for steps 1-2 (load + fingerprint
 * short-circuit) and 5 (the write transaction) — this function is the
 * orchestration plan §7.1 describes, not where the SQL lives.
 */
const enrich: StepSpec = {
  name: ENRICH_STEP,
  description: "Classify one recipe's ingredients into allergen and diet labels",
  jobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
  run: async ({ payload, log: line, enqueue }) => {
    const { recipeId, force } = parseEnrichPayload(payload);
    const pool = getPool();

    // Step 1: load. A missing recipe completes as "gone" — a deleted recipe
    // is not a failure, and jobs outlive rows.
    const recipe = await loadRecipe(pool, recipeId);
    if (!recipe) {
      await line(`recipe ${recipeId} no longer exists`);
      return { status: "gone" };
    }

    // Step 2: the fingerprint short-circuit (D10). Order-independent by
    // construction — `contentFingerprint` sorts the ingredient lines itself —
    // so re-ordering a recipe's ingredients never trips a reclassify on its own.
    const inputHash = await contentFingerprint(
      recipe.name,
      recipe.lines.map((line) => line.text),
    );
    // Read unconditionally now, not only when `!force`: the write below needs
    // to know whether the CONTENT changed, which is a different question from
    // whether to short-circuit, and the answer to both is in this one row.
    const state = await getEnrichmentState(pool, recipeId);
    if (!force && state && state.status === "ok" && state.classifierVersion === CLASSIFIER_VERSION && state.inputHash === inputHash) {
      return { status: "unchanged" };
    }
    // The LLM's labels are derived from ingredient lines. When those lines
    // change, its labels become evidence about a recipe that no longer exists,
    // and the rules write cascades them away (llm plan §9.1) rather than
    // leaving them to be quietly re-read as current. A recipe with no prior
    // hash has no prior labels of either kind, so there is nothing to cascade.
    const contentChanged = state?.inputHash != null && state.inputHash !== inputHash;

    try {
      // Steps 3-4: parse, match against the food lexicon, classify.
      const lines = await buildClassifierLines(recipe.lines);
      const labels = classify({ recipeName: recipe.name, lines });

      // Step 5: one transaction — replace the labels, upsert the row to `ok`.
      await writeEnrichment(pool, recipeId, inputHash, CLASSIFIER_VERSION, labels, { contentChanged });
      await line(`classified ${lines.length} lines into ${labels.length} labels`);

      // Step 6: hand the recipe to the second provider (llm plan §9.2). Always
      // enqueued, never conditional — the gate lives INSIDE `llm-enrich` (L3),
      // so this line does not need to know whether PostHog exists, what the
      // flag says, or whether a provider is configured, and cannot drift from
      // the answer when any of those change.
      //
      // BEST-EFFORT on purpose, and this catch is the whole reason `llm-backfill`
      // exists: a failed enqueue costs freshness, not correctness. The durable
      // signal is the `recipe_enrichment` row this transaction just committed —
      // `llm_status` stays null, which is exactly what the backfill claims.
      // Throwing here would instead fail a job whose real work is already
      // committed, and retry it into a re-classification that changes nothing.
      try {
        await enqueue(RECIPE_ENRICHMENT_QUEUE, {
          step: LLM_ENRICH_STEP,
          data: { recipeId, force } satisfies LlmEnrichPayload,
          // Deterministic id, so this handoff and a concurrent `llm-backfill`
          // claim for the same recipe collapse into one job rather than paying
          // for two model calls (`llmEnrichJobId`'s doc comment).
          opts: { jobId: llmEnrichJobId(recipeId) },
        });
      } catch (err) {
        log.warn("failed to enqueue llm-enrich; llm-backfill will find it", { recipeId, err: err instanceof Error ? err.message : String(err) });
      }

      return { status: "ok", labels: labels.length };
    } catch (err) {
      // Caught OUTSIDE writeEnrichment's transaction, on purpose (plan §7.1
      // step 5): a failure that writes nothing is a failure nobody can see.
      // Re-thrown after recording it, so this step still gets the retry its
      // own `attempts`/`backoff` promise — this is a checkpoint, not a catch
      // that swallows the failure the way `sync-repo`'s does for its own reasons.
      const message = describeWriteError(err);
      log.error("enrich failed", { recipeId, err: message });
      await markError(pool, recipeId, message);
      throw err;
    }
  },
};

// --- backfill ----------------------------------------------------------

function parseBackfillPayload(payload: unknown): Required<BackfillPayload> {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    // `number | string`, matching `atproto-sync`'s `scopeOf`: this payload
    // arrives as hand-written JSON from `POST /jobs/recipe-enrichment` or from
    // the board's add-job panel, and `{"limit":"50"}` is as likely to be typed
    // as `{"limit":50}`. `claimBatch` floors, clamps and caps whatever it gets.
    limit: typeof raw.limit === "number" || typeof raw.limit === "string" ? Number(raw.limit) || DEFAULT_BACKFILL_LIMIT : DEFAULT_BACKFILL_LIMIT,
    force: raw.force === true,
    localOnly: raw.localOnly === true,
  };
}

/**
 * Claim a batch (see `lib/load.ts`'s `claimBatch` for the SQL and the ordering
 * it enforces) and fan it out. Reached with `POST /jobs/recipe-enrichment` and
 * `{"name":"backfill"}` — no schedule, no boot-time re-enqueue (D15):
 * reprocessing the corpus is a decision someone makes, not something a deploy
 * triggers on its own.
 */
const backfill: StepSpec = {
  name: BACKFILL_STEP,
  description: "Claim a batch of stale/outdated recipes and fan them out as enrich children",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, log: line, flow }) => {
    const { limit, force, localOnly } = parseBackfillPayload(payload);
    const pool = getPool();

    const { ids, remaining } = await claimBatch(pool, { classifierVersion: CLASSIFIER_VERSION, limit, force, localOnly });
    await line(`claimed ${ids.length} recipes${force ? " (forced)" : ""}${localOnly ? " (local only)" : ""}, ${remaining} candidates remain`);
    log.info("backfill claimed", { claimed: ids.length, remaining, force, localOnly });

    const report: BackfillReportPayload = { claimed: ids.length, remaining, force, localOnly };
    // One atomic flow call: N `enrich` children, plus the report job that
    // waits on all of them. Works fine with zero children — an empty batch
    // still gets a report, so "nothing to do" is visible on the board too.
    await flow({
      step: BACKFILL_REPORT_STEP,
      data: report,
      children: ids.map((recipeId) => ({ step: ENRICH_STEP, data: { recipeId, force } satisfies EnrichPayload })),
    });

    return report;
  },
};

// --- backfill-report ---------------------------------------------------

/** Fold what the claimed batch's `enrich` children returned, and log it. */
const backfillReport: StepSpec = {
  name: BACKFILL_REPORT_STEP,
  description: "Fold a backfill run's children and log how many candidates remain",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, children, log: line }) => {
    const input = payload as BackfillReportPayload;
    const results = await children();

    const counts = { ok: 0, unchanged: 0, gone: 0, other: 0 };
    for (const value of results.values) {
      const status = value && typeof value === "object" && "status" in value ? String((value as { status?: unknown }).status) : "other";
      if (status === "ok" || status === "unchanged" || status === "gone") counts[status] += 1;
      else counts.other += 1;
    }

    const summary = {
      claimed: input.claimed,
      remaining: input.remaining,
      force: input.force,
      localOnly: input.localOnly,
      succeeded: results.values.length,
      failed: results.failures.length,
      ...counts,
    };
    await line(`backfill complete: ${JSON.stringify(summary)}`);
    log.info("backfill complete", summary);
    return summary;
  },
};

// ===========================================================================
// The LLM second opinion (docs/plans/2026-08-26-llm-recipe-enrichment.md)
// ===========================================================================

/**
 * Everything below is the second label provider. It shares this queue, this
 * table and this recipe's `method` column with the rules trio above, and owns
 * a disjoint set of rows in it (`llm:%`, L9).
 *
 * Why a STEP and not another entry in `classifiers/index.ts` (L3): that array's
 * contract is `(input) => Label[]` — pure, synchronous, no I/O — and the whole
 * value of that contract is that `classify.test.ts` can be a plain suite with
 * no fixtures. A model call is none of those things. A step is also what gives
 * it its own retry boundary, which a provider that rate-limits and occasionally
 * returns invalid JSON very much needs.
 *
 * Why every LLM import below is `await import(...)`, inside the run function
 * (plan §4): `ai`, `@ai-sdk/openai-compatible`, `zod` and `posthog-node` are
 * this workflow's heaviest dependencies by far, and nothing outside these steps
 * touches them. `run:once`, the server's boot, and every `enrich` job stay
 * exactly as cheap as they were — the same reason the web app imports `pg`
 * inside its server-fn handlers rather than at module scope.
 */

// --- llm-enrich ------------------------------------------------------------

function parseLlmEnrichPayload(payload: unknown): LlmEnrichPayload {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
  if (!recipeId) {
    throw new UnrecoverableError("llm-enrich job has no recipeId");
  }
  return { recipeId, force: raw.force === true };
}

/**
 * A model's second opinion on one recipe (plan §9.2).
 *
 * The gate is the first thing that happens and it FAILS CLOSED: an env override
 * of `"false"`, a PostHog flag that is not explicitly `true`, no PostHog client
 * at all, or a flag evaluation that throws — every one of those marks the
 * recipe `skipped` and returns without constructing a provider, let alone
 * calling one. `skipped` is recorded rather than left null so `llm-backfill`
 * does not re-claim the same recipes on every run while the flag is off, and
 * `force` is what makes them candidates again when it comes on (plan §3.1).
 *
 * The rules pass is a precondition, not a race: this step requires
 * `recipe_enrichment.status='ok'`, the rules `input_hash` equal to the current
 * content fingerprint, AND `classifier_version` equal to the deployed
 * `CLASSIFIER_VERSION`. All three, because `merge.ts` reasons about the rules
 * labels that are actually in the table — see the note on `rulesLabels` below.
 * Anything else marks `skipped` and returns: the next `enrich` for this recipe
 * re-enqueues us, so there is nothing to retry and nothing lost.
 */
const llmEnrich: StepSpec = {
  name: LLM_ENRICH_STEP,
  description: "Ask a model for a second opinion on one recipe's labels, and for the dimensions no rule covers",
  jobOptions: {
    // Three attempts from 10s, exponential (plan §9.2): LLM providers rate-limit,
    // and a 429 that retried in 5s the way `enrich` does would mostly just spend
    // another slot being told 429 again.
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
  run: async ({ payload, log: line }) => {
    const { recipeId, force } = parseLlmEnrichPayload(payload);
    const pool = getPool();

    const { LLM_ENRICHMENT_VERSION } = await import("#/workflows/recipe-enrichment/llm/schema.ts");
    const { isLlmEnrichmentEnabled } = await import("#/workflows/recipe-enrichment/llm/posthog.ts");
    const { getLlmEnrichmentState, markLlmError, markLlmSkipped, writeLlmEnrichment } = await import("#/workflows/recipe-enrichment/lib/load.ts");

    // Steps 1-2: the gate. `isLlmEnrichmentEnabled` owns the whole order —
    // env override first (so dev never pays for a `$feature_flag_called`
    // event), then the flag keyed on THIS RECIPE's id, so a 10% rollout is a
    // deterministic 10% of the corpus rather than 10% of anybody's users (L4).
    if (!(await isLlmEnrichmentEnabled(recipeId))) {
      await markLlmSkipped(pool, recipeId);
      await line(`llm enrichment is not enabled for ${recipeId} — skipped`);
      return { status: "skipped" };
    }

    // Step 3a: load. Same "gone" outcome as `enrich` — jobs outlive rows.
    const recipe = await loadRecipe(pool, recipeId);
    if (!recipe) {
      await line(`recipe ${recipeId} no longer exists`);
      return { status: "gone" };
    }

    const inputHash = await contentFingerprint(
      recipe.name,
      recipe.lines.map((l) => l.text),
    );

    // Step 3b: the rules pass must have finished, on THIS content, under the
    // deployed classifier. See this step's doc comment.
    const state = await getLlmEnrichmentState(pool, recipeId);
    if (!state || state.status !== "ok" || state.inputHash !== inputHash || state.classifierVersion !== CLASSIFIER_VERSION) {
      await markLlmSkipped(pool, recipeId);
      await line(`rules pass for ${recipeId} is missing or stale — skipped; the next enrich re-enqueues this`);
      return { status: "skipped" };
    }

    // Step 4: the short-circuit (plan §3.1). Prompt version is deliberately not
    // part of it (L8): iterating prompt wording in PostHog must not silently
    // re-run the corpus. When a prompt change IS worth a re-run, that is a
    // deliberate `llm-backfill {"force":true}`, chosen by a person.
    if (!force && state.llmStatus === "ok" && state.llmVersion === LLM_ENRICHMENT_VERSION && state.llmInputHash === inputHash) {
      return { status: "unchanged" };
    }

    const { classifyWithLlm, LlmClassifyError } = await import("#/workflows/recipe-enrichment/llm/classify.ts");
    const { mergeLlmLabels } = await import("#/workflows/recipe-enrichment/llm/merge.ts");
    const { fetchPrompt } = await import("#/workflows/recipe-enrichment/llm/prompt-fetch.ts");
    const { resolveProvider } = await import("#/workflows/recipe-enrichment/llm/provider.ts");
    const { sendDisagreementEvent, sendGenerationEvent } = await import("#/workflows/recipe-enrichment/llm/capture.ts");

    const lines = await buildClassifierLines(recipe.lines);
    // The rules labels the model is shown as context, and the ones `merge.ts`
    // refuses to overrule, are RE-DERIVED rather than read back out of
    // `recipe_enrichment_label`. That is sound precisely because of the three
    // checks above: `classify` is pure, the content fingerprint matches what
    // was classified, and the stored `classifier_version` is the one this
    // process is running. Same input, same classifier, same labels — so this
    // is the rows that are in the table, computed instead of fetched, and it
    // saves a query on the one path where a query buys nothing.
    const rulesLabels = classify({ recipeName: recipe.name, lines });

    // One trace per run, so a generation, its disagreements and its retries
    // are one thing in PostHog's Traces view rather than N unrelated events.
    const traceId = crypto.randomUUID();
    const prompt = await fetchPrompt();
    const provider = await resolveProvider();
    const llmModel = `${provider.providerName}:${provider.modelId}`;
    const unresolvedLineCount = lines.filter((l) => l.foodSlug === null).length;

    try {
      const result = await classifyWithLlm({
        model: provider.model,
        promptText: prompt.text,
        recipeName: recipe.name,
        lines,
        rulesLabels,
        // Sixty seconds is the job's budget for the call, not the provider's
        // (plan §9.2 step 5) — a provider that hangs must not hold a
        // concurrency slot until BullMQ's own stalled-job machinery notices.
        abortSignal: AbortSignal.timeout(60_000),
      });

      // Steps 6: the policy, then the write. `merge.ts` is where every
      // "may the model say this?" question is answered — nothing here decides
      // anything about a label.
      const { writes, disagreements } = mergeLlmLabels({
        rulesLabels,
        llm: result.output,
        lines,
        provider: provider.providerName,
        model: provider.modelId,
      });

      await writeLlmEnrichment(pool, recipeId, { llmVersion: LLM_ENRICHMENT_VERSION, llmInputHash: inputHash, llmModel, llmPromptVersion: prompt.version }, writes);

      // Step 7: capture, AFTER the write and never able to undo it. Every call
      // below is fire-and-forget and swallows its own failures (see
      // `llm/posthog.ts`) — observability is not load-bearing, and a PostHog
      // outage must not turn a recipe that was labelled correctly into a job
      // that retries and labels it again.
      await sendGenerationEvent({
        traceId,
        model: provider.modelId,
        provider: provider.providerName,
        baseUrl: provider.baseURL,
        latencyMs: result.latencyMs,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        httpStatus: result.httpStatus ?? 200,
        recipeId,
        recipeOrigin: recipe.origin === "local" ? "local" : "sync",
        promptName: prompt.name,
        promptVersion: prompt.version,
        llmVersion: LLM_ENRICHMENT_VERSION,
        labelsWritten: writes.length,
        disagreements: disagreements.length,
        lineCount: lines.length,
        unresolvedLineCount,
        messages: result.messages,
        outputChoices: result.outputChoices,
      });
      for (const disagreement of disagreements) {
        await sendDisagreementEvent({ recipeId, recipeOrigin: recipe.origin === "local" ? "local" : "sync", disagreement });
      }

      await line(`llm wrote ${writes.length} labels, ${disagreements.length} disagreements, prompt v${prompt.version ?? "fallback"}`);
      return { status: "ok", labels: writes.length, disagreements: disagreements.length };
    } catch (err) {
      // Same checkpoint idiom as `enrich`, outside any transaction: record the
      // failure where somebody can see it, capture the error generation, then
      // re-throw so this step still gets the retries its own `attempts`
      // promise. A schema rejection lands here carrying the model's raw text
      // (plan §7.1) — Kimi occasionally drooling invalid JSON is an expected
      // failure mode, and retry-then-error is the honest response to it.
      const rawText = err instanceof LlmClassifyError ? err.rawText : undefined;
      const message = describeWriteError(err);
      log.error("llm-enrich failed", { recipeId, err: message });
      await markLlmError(pool, recipeId, message);
      await sendGenerationEvent({
        traceId,
        model: provider.modelId,
        provider: provider.providerName,
        baseUrl: provider.baseURL,
        latencyMs: 0,
        usage: { inputTokens: undefined, outputTokens: undefined },
        httpStatus: 0,
        recipeId,
        recipeOrigin: recipe.origin === "local" ? "local" : "sync",
        promptName: prompt.name,
        promptVersion: prompt.version,
        llmVersion: LLM_ENRICHMENT_VERSION,
        labelsWritten: 0,
        disagreements: 0,
        lineCount: lines.length,
        unresolvedLineCount,
        messages: [],
        outputChoices: [],
        error: { message: rawText ? `${message} — raw: ${rawText}` : message },
      });
      throw err;
    }
  },
};

// --- llm-backfill ----------------------------------------------------------

function parseLlmBackfillPayload(payload: unknown): Required<LlmBackfillPayload> {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    limit: typeof raw.limit === "number" || typeof raw.limit === "string" ? Number(raw.limit) || DEFAULT_BACKFILL_LIMIT : DEFAULT_BACKFILL_LIMIT,
    force: raw.force === true,
    localOnly: raw.localOnly === true,
  };
}

/**
 * The rules backfill's twin, over `llm_status`/`llm_version` instead of
 * `status`/`classifier_version` (plan §9.2). Reached the same way:
 *
 *   POST /jobs/recipe-enrichment {"name":"llm-backfill","data":{"limit":20}}
 *
 * and, like the rules one, on no schedule and with no boot-time re-enqueue
 * (D15). This is the catch-up path, not the primary one: a recipe normally
 * reaches the LLM because `enrich` handed it over directly. This is for the
 * ones that fell through — an enqueue that failed, a version bump, or a flag
 * that was off when they went past and is on now. That last case is the one
 * that needs `force`: a `skipped` row is not stale by any version test, so
 * only `{"force":true}` claims it back.
 */
const llmBackfill: StepSpec = {
  name: LLM_BACKFILL_STEP,
  description: "Claim a batch of recipes whose LLM pass is missing, errored or outdated, and fan them out as llm-enrich children",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, log: line, flow }) => {
    const { limit, force, localOnly } = parseLlmBackfillPayload(payload);
    const pool = getPool();
    const { LLM_ENRICHMENT_VERSION } = await import("#/workflows/recipe-enrichment/llm/schema.ts");
    const { claimLlmBatch } = await import("#/workflows/recipe-enrichment/lib/load.ts");

    const { ids, remaining } = await claimLlmBatch(pool, { llmVersion: LLM_ENRICHMENT_VERSION, limit, force, localOnly });
    await line(`claimed ${ids.length} recipes for llm enrichment${force ? " (forced)" : ""}${localOnly ? " (local only)" : ""}, ${remaining} candidates remain`);
    log.info("llm-backfill claimed", { claimed: ids.length, remaining, force, localOnly });

    const report: BackfillReportPayload = { claimed: ids.length, remaining, force, localOnly };
    await flow({
      step: LLM_BACKFILL_REPORT_STEP,
      data: report,
      children: ids.map((recipeId) => ({
        step: LLM_ENRICH_STEP,
        data: { recipeId, force } satisfies LlmEnrichPayload,
        // The same deterministic id `enrich`'s handoff uses, so a claim that
        // races an `enrich` handoff for the same recipe collapses to one job
        // rather than paying for two model calls (`llmEnrichJobId`'s doc).
        opts: { jobId: llmEnrichJobId(recipeId) },
      })),
    });

    return report;
  },
};

// --- llm-backfill-report ---------------------------------------------------

/** Fold what an `llm-backfill` run's children returned. The rules report's twin, with `skipped` — the flag's own outcome — counted as its own thing. */
const llmBackfillReport: StepSpec = {
  name: LLM_BACKFILL_REPORT_STEP,
  description: "Fold an llm-backfill run's children and log how many candidates remain",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, children, log: line }) => {
    const input = payload as BackfillReportPayload;
    const results = await children();

    // `skipped` is first-class here in a way it is not in the rules report:
    // during a canary rollout it is the EXPECTED outcome for most children,
    // and a run that reports "0 ok, 480 skipped" is the flag working, not the
    // workflow failing.
    const counts = { ok: 0, unchanged: 0, skipped: 0, gone: 0, other: 0 };
    for (const value of results.values) {
      const status = value && typeof value === "object" && "status" in value ? String((value as { status?: unknown }).status) : "other";
      if (status === "ok" || status === "unchanged" || status === "skipped" || status === "gone") counts[status] += 1;
      else counts.other += 1;
    }

    const summary = {
      claimed: input.claimed,
      remaining: input.remaining,
      force: input.force,
      localOnly: input.localOnly,
      succeeded: results.values.length,
      failed: results.failures.length,
      ...counts,
    };
    await line(`llm-backfill complete: ${JSON.stringify(summary)}`);
    log.info("llm-backfill complete", summary);
    return summary;
  },
};

export const steps: readonly StepSpec[] = [enrich, backfill, backfillReport, llmEnrich, llmBackfill, llmBackfillReport];
