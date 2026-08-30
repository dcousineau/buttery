import fp from "fastify-plugin";
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { generateText, Output } from "ai";
import { ENRICH_JOB, LLM_ENRICH_JOB, llmEnrichJobId, type LlmEnrichPayload, RECIPE_ENRICHMENT_QUEUE } from "@buttery/pipeline-contract";
import { CLASSIFIER_VERSION, classify } from "@buttery/food/classify";
import {
  buildClassifierLines,
  contentChanged,
  describeWriteError,
  fingerprintRecipe,
  getEnrichmentState,
  getLlmEnrichmentState,
  isLlmFresh,
  isRulesFresh,
  loadRecipe,
  markError,
  markLlmError,
  markLlmSkipped,
  rulesPassCurrent,
  writeEnrichment,
  writeLlmEnrichment,
} from "#/queues/recipe-enrichment/lib/load.ts";
import { FALLBACK_PROMPT, LLM_ENRICHMENT_VERSION, llmOutputSchema, PROMPT_NAME, PROMPT_SLUG_LISTS } from "@buttery/food/llm";
import { isLlmEnrichmentEnabled } from "#/queues/recipe-enrichment/lib/posthog.ts";
import { mergeLlmLabels } from "#/queues/recipe-enrichment/lib/merge.ts";
import { AI_FEATURE, captureEnrichmentCompleted, captureEnrichmentFailed, PIPELINE_DISTINCT_ID } from "#/queues/recipe-enrichment/lib/capture.ts";
import { generationTelemetry } from "#/lib/ai/telemetry.ts";
import { buildMessages, buildRecipeJson } from "#/queues/recipe-enrichment/lib/llm-messages.ts";

/**
 * Derive per-recipe allergen/diet labels, then ask a model for a second
 * opinion. One queue, two jobs, both handled below by `runEnrich` (rules,
 * entry) and `runLlmEnrich` (LLM second opinion). The two providers write
 * disjoint rows in one `recipe_enrichment_label` table, split by the `method`
 * column's prefix (`rules@N` vs `llm:%`).
 *
 * Everything else this queue needs is in this folder:
 *
 *   lib/llm-messages.ts   the `ModelMessage[]` wrapper and the raw-text reader
 *   lib/merge.ts          pure: reconciling rules labels against the LLM's opinion
 *   lib/load.ts           the reads and writes against `recipe_enrichment*`
 *   lib/capture.ts        the `$ai_generation`/disagreement event shapes
 *   lib/posthog.ts        the fail-closed `LLM_ENRICHMENT_FLAG` gate
 *
 * The prompt itself is NOT in this folder any more. `PROMPT_NAME`,
 * `FALLBACK_PROMPT`, `PROMPT_SLUG_LISTS`, the closed slug sets,
 * `llmOutputSchema`, `LLM_ENRICHMENT_VERSION` and `llmMethod` all live in
 * `@buttery/food/llm`, beside the rules classifier this step asks the model to
 * second-guess — one package owns all of food classification, and the enums
 * the prompt asks for sit next to the zod layer that enforces them. What is
 * left here is what has I/O or an AI SDK in it.
 *
 * `fastify.db`, `fastify.ai` and `fastify.posthog` replace this queue's own
 * former copies of a pool, a provider resolver and a PostHog client — see
 * `plugins/db.ts`, `plugins/ai.ts` and `plugins/posthog.ts`.
 *
 * ── WHAT USED TO BE IMPLICIT ─────────────────────────────────────────────
 *
 * The old `defineWorkflow` kernel read a step's `jobOptions` and applied it
 * automatically at every enqueue site, including the `enrich → llm-enrich`
 * handoff. `fastify.bullmq` has no such hook — a `Queue` is just a `Queue` —
 * so `ENRICH_JOB_OPTIONS` and `LLM_ENRICH_JOB_OPTIONS` below are now passed
 * explicitly at every `queue.add` call, including that handoff. The one place
 * that still can't is `POST /jobs/:queue` (`server.ts`): it has no per-job
 * options to reach for, so it falls back to `defaultJobOptions` — a shorter
 * retry-less enqueue for anything triggered by hand through the API rather
 * than by the pipeline's own retry-aware handoff. That is a deliberate,
 * accepted difference, not a gap to close here.
 */

const LLM_MAX_OUTPUT_TOKENS = 4096;
const LLM_TIMEOUT_MS = 60_000;

/** `queue.add` options for `enrich` — was the `enrich` `StepSpec.jobOptions`. */
export const ENRICH_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

/** `queue.add` options for `llm-enrich` — was the `llm-enrich` `StepSpec.jobOptions`. */
export const LLM_ENRICH_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

// --- enrich (entry) --------------------------------------------------------

function parseEnrichPayload(data: unknown): { recipeId: string; force: boolean } {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
  if (!recipeId) {
    throw new UnrecoverableError("enrich job has no recipeId");
  }
  return { recipeId, force: raw.force === true };
}

/**
 * Classify one recipe's ingredients into allergen and diet labels, then hand
 * the same recipe to `llm-enrich` on this same queue for a second opinion.
 */
export async function runEnrich(fastify: FastifyInstance, queue: Queue, job: Job): Promise<unknown> {
  const { recipeId, force } = parseEnrichPayload(job.data);
  const pool = fastify.db;

  const recipe = await loadRecipe(pool, recipeId);
  if (!recipe) {
    await job.log(`recipe ${recipeId} no longer exists`);
    return { status: "gone" };
  }

  const inputHash = await fingerprintRecipe(recipe);
  const state = await getEnrichmentState(pool, recipeId);
  if (isRulesFresh(state, inputHash, CLASSIFIER_VERSION, force)) {
    return { status: "unchanged" };
  }

  try {
    const lines = await buildClassifierLines(recipe.lines);
    const labels = classify({ recipeName: recipe.name, lines });

    await writeEnrichment(pool, recipeId, inputHash, CLASSIFIER_VERSION, labels, { contentChanged: contentChanged(state, inputHash) });
    await job.log(`classified ${lines.length} lines into ${labels.length} labels`);

    try {
      // Best-effort: the durable signal is the recipe_enrichment row this
      // transaction just committed, not this enqueue.
      //
      // `queue` here is the very `Queue` this processor is running against —
      // handing a job to your own queue was never a cross-workflow concern,
      // the old engine's `ctx.enqueue(queueName, ...)` just had no way to say
      // "this queue" without a name lookup, so every handoff paid for one,
      // including this same-queue one. There is no indirection left to pay for.
      // llmEnrichJobId makes duplicate triggers for one recipe collapse to one job.
      const llmJobId = llmEnrichJobId(recipeId);

      // ...which is exactly what `force` is asking us NOT to do. BullMQ's
      // dedupe is not scoped to jobs still waiting: `add` silently returns the
      // EXISTING job whenever that id is present anywhere, and
      // `removeOnComplete: { count: 200 }` keeps the last llm-enrich for this
      // recipe sitting in the completed set. Without this removal a forced
      // re-run enqueues nothing, the worker never wakes, and the recipe looks
      // "skipped" with no job and no log line to explain it. `remove` is a
      // no-op on a missing id and refuses to remove a job that is currently
      // active, both of which are the behavior we want here.
      if (force) {
        await queue.remove(llmJobId);
      }

      await queue.add(LLM_ENRICH_JOB, { recipeId, force } satisfies LlmEnrichPayload, {
        ...LLM_ENRICH_JOB_OPTIONS,
        jobId: llmJobId,
      });
    } catch (err) {
      fastify.log.warn({ recipeId, err: err instanceof Error ? err.message : String(err) }, "failed to enqueue llm-enrich");
    }

    return { status: "ok", labels: labels.length };
  } catch (err) {
    const message = describeWriteError(err);
    fastify.log.error({ recipeId, err: message }, "enrich failed");
    await markError(pool, recipeId, message);
    throw err;
  }
}

// --- llm-enrich --------------------------------------------------------------

function parseLlmEnrichPayload(data: unknown): { recipeId: string; force: boolean } {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
  if (!recipeId) {
    throw new UnrecoverableError("llm-enrich job has no recipeId");
  }
  return { recipeId, force: raw.force === true };
}

/** Ask a model for a second opinion on one recipe's labels, and for the dimensions no rule covers. */
export async function runLlmEnrich(fastify: FastifyInstance, job: Job): Promise<unknown> {
  const { recipeId, force } = parseLlmEnrichPayload(job.data);
  const pool = fastify.db;

  // The gate FAILS CLOSED: no PostHog, or the flag not explicitly true, marks the recipe skipped and calls nothing.
  if (!(await isLlmEnrichmentEnabled(fastify.posthog.client, recipeId, fastify.log))) {
    await markLlmSkipped(pool, recipeId);
    await job.log(`llm enrichment is not enabled for ${recipeId} — skipped`);
    return { status: "skipped" };
  }

  const recipe = await loadRecipe(pool, recipeId);
  if (!recipe) {
    await job.log(`recipe ${recipeId} no longer exists`);
    return { status: "gone" };
  }

  const inputHash = await fingerprintRecipe(recipe);
  const state = await getLlmEnrichmentState(pool, recipeId);
  if (!rulesPassCurrent(state, inputHash, CLASSIFIER_VERSION)) {
    await markLlmSkipped(pool, recipeId);
    await job.log(`rules pass for ${recipeId} is missing or stale — skipped; the next enrich re-enqueues this`);
    return { status: "skipped" };
  }
  // Resolved BEFORE the short-circuit, because they are now part of it: the
  // stored labels are only fresh if the model and prompt that produced them
  // are the ones that would run again (see `isLlmFresh`). Neither resolution
  // is expensive enough to regret on a job that then skips — `fetchPrompt`
  // serves from the SDK's TTL cache and never throws, and `resolveProvider`
  // reads env and an already-imported module.
  const prompt = await fastify.posthog.fetchPrompt(PROMPT_NAME, FALLBACK_PROMPT);
  const provider = await fastify.ai.resolveProvider();
  const llmModel = `${provider.providerName}:${provider.modelId}`;

  if (isLlmFresh(state, inputHash, LLM_ENRICHMENT_VERSION, { model: llmModel, promptVersion: prompt.version }, force)) {
    return { status: "unchanged" };
  }

  const lines = await buildClassifierLines(recipe.lines);
  const rulesLabels = classify({ recipeName: recipe.name, lines });

  const traceId = crypto.randomUUID();
  const recipeOrigin = recipe.origin === "local" ? "local" : "sync";

  try {
    const recipeJson = buildRecipeJson({ recipeName: recipe.name, lines, rulesLabels });
    // The closed slug lists ride in as variables rather than being typed into
    // the prompt text, so a `schema.ts` edit reaches the model on the next job
    // whether the prompt came from PostHog or the code fallback — see
    // `@buttery/food/llm`'s PROMPT_SLUG_LISTS.
    const messages = buildMessages({ promptText: prompt.text, recipeJson, variables: PROMPT_SLUG_LISTS });

    const result = await generateText({
      model: provider.model,
      output: Output.object({ schema: llmOutputSchema }),
      messages,
      allowSystemInMessages: true,
      // How this provider has to be called is the registry's business, not this step's — see lib/ai/provider.ts.
      providerOptions: provider.providerOptions,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      // PostHog gets this generation from the AI SDK's own spans now, not from
      // an event we assemble — see `lib/ai/telemetry.ts` and
      // `plugins/telemetry.ts`. Latency, tokens, model, prompt text and the
      // error case all come for free; what is left here is the recipe context
      // PostHog cannot know. Every generation is recorded in full regardless of
      // origin — `recipe_origin` below is a slice, not a gate.
      telemetry: generationTelemetry({
        enabled: fastify.telemetry.enabled,
        traceId,
        distinctId: PIPELINE_DISTINCT_ID,
        functionId: "classify-recipe",
        attributes: {
          ai_feature: AI_FEATURE,
          recipe_id: recipeId,
          recipe_origin: recipeOrigin,
          prompt_name: prompt.name,
          // Both spellings, deliberately: the `$ai_`-prefixed pair is
          // PostHog's own convention for tying a generation to its Prompt
          // Management version, and the unprefixed pair is what the §5.3
          // dashboard and §5.4 evaluations already filter on. Dropping either
          // silently breaks something somebody built.
          prompt_version: prompt.version,
          $ai_prompt_name: prompt.name,
          $ai_prompt_version: prompt.version,
          llm_version: LLM_ENRICHMENT_VERSION,
          // Known before the call, so they ride the span. The merge counts are
          // not, and ride `llm_enrichment_completed` instead — see capture.ts.
          line_count: lines.length,
          unresolved_line_count: lines.filter((line) => line.foodSlug === null).length,
          // Unit prices, forwarded only when configured. UNVERIFIED against
          // live PostHog: whether OTLP ingestion honours these the way
          // `posthog-node` capture did is not something this environment can
          // establish (no project access) — see the results file's §5 note.
          // Emitting them cannot produce WRONG cost data, only ignored
          // attributes, which is why they stay rather than being deleted.
          $ai_input_token_price: fastify.env.LLM_INPUT_TOKEN_PRICE_USD ? Number(fastify.env.LLM_INPUT_TOKEN_PRICE_USD) : null,
          $ai_output_token_price: fastify.env.LLM_OUTPUT_TOKEN_PRICE_USD ? Number(fastify.env.LLM_OUTPUT_TOKEN_PRICE_USD) : null,
        },
      }),
    });

    const { writes, disagreements } = mergeLlmLabels({
      rulesLabels,
      llm: result.output,
      lines,
      provider: provider.providerName,
      model: provider.modelId,
    });

    await writeLlmEnrichment(pool, recipeId, { llmVersion: LLM_ENRICHMENT_VERSION, llmInputHash: inputHash, llmModel, llmPromptVersion: prompt.version }, writes);

    // What the generation span could not carry, because it did not exist yet
    // when the span was created: the merge outcome. Same `$ai_trace_id`, so
    // the two join in PostHog.
    captureEnrichmentCompleted(fastify.posthog.client, fastify.log, {
      traceId,
      recipeId,
      recipeOrigin,
      provider,
      prompt,
      lines,
      llmVersion: LLM_ENRICHMENT_VERSION,
      writes,
      disagreements,
    });

    await job.log(`llm wrote ${writes.length} labels, ${disagreements.length} disagreements, prompt v${prompt.version ?? "fallback"}`);
    return { status: "ok", labels: writes.length, disagreements: disagreements.length };
  } catch (err) {
    const message = describeWriteError(err);
    fastify.log.error({ recipeId, err: message }, "llm-enrich failed");
    await markLlmError(pool, recipeId, message);
    // NOT a second `$ai_generation`. A transport failure already produced an
    // errored generation span inside the SDK; a schema rejection produced a
    // SUCCESSFUL one, because the model answered and the tokens were spent —
    // only the parse failed. Either way one model call stays one generation,
    // and this event is where the failure signal lives. See capture.ts.
    captureEnrichmentFailed(fastify.posthog.client, fastify.log, {
      traceId,
      recipeId,
      recipeOrigin,
      provider,
      prompt,
      llmVersion: LLM_ENRICHMENT_VERSION,
      message,
      rawText: fastify.ai.modelRawText(err),
    });
    throw err;
  }
}

export default fp(
  (fastify) => {
    const queue = fastify.bullmq.queue({
      name: RECIPE_ENRICHMENT_QUEUE,
      description: "Derive allergen and diet labels for a recipe's ingredients",
      jobs: [
        { name: ENRICH_JOB, description: "Classify one recipe's ingredients into allergen and diet labels" },
        { name: LLM_ENRICH_JOB, description: "Ask a model for a second opinion on one recipe's labels, and for the dimensions no rule covers" },
      ],
      defaultJob: ENRICH_JOB,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
      globalConcurrency: Number(fastify.env.RECIPE_ENRICHMENT_MAX_IN_FLIGHT || 16) || undefined,
    });

    // Idiomatic BullMQ: one processor for the queue, switched on `job.name` —
    // not one `Worker` per job the way the old per-step kernel implied.
    fastify.bullmq.worker(RECIPE_ENRICHMENT_QUEUE, async (job) => {
      switch (job.name) {
        case ENRICH_JOB:
          return runEnrich(fastify, queue, job);
        case LLM_ENRICH_JOB:
          return runLlmEnrich(fastify, job);
        default:
          throw new UnrecoverableError(`unknown job "${job.name}"`);
      }
    });
  },
  { name: "recipe-enrichment", dependencies: ["bullmq", "db", "posthog", "ai"] },
);
