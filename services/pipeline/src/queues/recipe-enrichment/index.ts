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
import { LLM_ENRICHMENT_VERSION, llmOutputSchema } from "#/queues/recipe-enrichment/lib/schema.ts";
import { isLlmEnrichmentEnabled } from "#/queues/recipe-enrichment/lib/posthog.ts";
import { FALLBACK_PROMPT, PROMPT_NAME } from "#/queues/recipe-enrichment/lib/prompt.ts";
import { mergeLlmLabels } from "#/queues/recipe-enrichment/lib/merge.ts";
import { captureGeneration, captureGenerationFailure } from "#/queues/recipe-enrichment/lib/capture.ts";
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
 *   lib/schema.ts         the LLM output zod schema and its version
 *   lib/llm-messages.ts   pure: the `{{recipe_json}}` payload and the message array
 *   lib/merge.ts          pure: reconciling rules labels against the LLM's opinion
 *   lib/load.ts           the reads and writes against `recipe_enrichment*`
 *   lib/capture.ts        the `$ai_generation`/disagreement event shapes
 *   lib/posthog.ts         the fail-closed `LLM_ENRICHMENT_FLAG` gate
 *   lib/prompt.ts          the prompt PostHog serves, and the fallback text
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
      await queue.add(LLM_ENRICH_JOB, { recipeId, force } satisfies LlmEnrichPayload, {
        ...LLM_ENRICH_JOB_OPTIONS,
        // llmEnrichJobId makes duplicate triggers for one recipe collapse to one job.
        jobId: llmEnrichJobId(recipeId),
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
  if (isLlmFresh(state, inputHash, LLM_ENRICHMENT_VERSION, force)) {
    return { status: "unchanged" };
  }

  const lines = await buildClassifierLines(recipe.lines);
  const rulesLabels = classify({ recipeName: recipe.name, lines });

  const traceId = crypto.randomUUID();
  const prompt = await fastify.posthog.fetchPrompt(PROMPT_NAME, FALLBACK_PROMPT);
  const provider = await fastify.ai.resolveProvider();
  const recipeOrigin = recipe.origin === "local" ? "local" : "sync";

  try {
    const recipeJson = buildRecipeJson({ recipeName: recipe.name, lines, rulesLabels });
    const messages = buildMessages({ promptText: prompt.text, recipeJson });

    const startedAt = performance.now();
    const result = await generateText({
      model: provider.model,
      output: Output.object({ schema: llmOutputSchema }),
      messages,
      allowSystemInMessages: true,
      // How this provider has to be called is the registry's business, not this step's — see lib/ai/provider.ts.
      providerOptions: provider.providerOptions,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const latencyMs = performance.now() - startedAt;
    const outputChoices = [{ role: "assistant", content: JSON.stringify(result.output) }];

    const { writes, disagreements } = mergeLlmLabels({
      rulesLabels,
      llm: result.output,
      lines,
      provider: provider.providerName,
      model: provider.modelId,
    });

    await writeLlmEnrichment(
      pool,
      recipeId,
      { llmVersion: LLM_ENRICHMENT_VERSION, llmInputHash: inputHash, llmModel: `${provider.providerName}:${provider.modelId}`, llmPromptVersion: prompt.version },
      writes,
    );

    captureGeneration(fastify.posthog.client, fastify.log, {
      traceId,
      recipeId,
      recipeOrigin,
      provider,
      prompt,
      lines,
      messages,
      outputChoices,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      latencyMs,
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
    captureGenerationFailure(fastify.posthog.client, fastify.log, {
      traceId,
      recipeId,
      recipeOrigin,
      provider,
      prompt,
      lines,
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
