import fp from "fastify-plugin";
import { UnrecoverableError } from "bullmq";
import { generateText, Output } from "ai";
import { ENRICH_STEP, LLM_ENRICH_STEP, llmEnrichJobId, type LlmEnrichPayload, RECIPE_ENRICHMENT_QUEUE } from "@buttery/pipeline-contract";
import type { StepSpec } from "#/plugins/workflow.ts";
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
} from "#/workflows/recipe-enrichment/lib/load.ts";
import { LLM_ENRICHMENT_VERSION, llmOutputSchema } from "#/workflows/recipe-enrichment/lib/schema.ts";
import { isLlmEnrichmentEnabled } from "#/workflows/recipe-enrichment/lib/posthog.ts";
import { FALLBACK_PROMPT, PROMPT_NAME } from "#/workflows/recipe-enrichment/lib/prompt.ts";
import { mergeLlmLabels } from "#/workflows/recipe-enrichment/lib/merge.ts";
import { captureGeneration, captureGenerationFailure } from "#/workflows/recipe-enrichment/lib/capture.ts";
import { buildMessages, buildRecipeJson } from "#/workflows/recipe-enrichment/lib/llm-messages.ts";

/**
 * Derive per-recipe allergen/diet labels, then ask a model for a second
 * opinion. Two steps, both inline below: `enrich` (rules, entry) and
 * `llm-enrich` (LLM second opinion). The two providers write disjoint rows in
 * one `recipe_enrichment_label` table, split by the `method` column's prefix
 * (`rules@N` vs `llm:%`).
 *
 * Everything else this workflow needs is in this folder:
 *
 *   types.ts             what the two steps and their helpers share
 *   lib/schema.ts         the LLM output zod schema and its version
 *   lib/llm-messages.ts   pure: the `{{recipe_json}}` payload and the message array
 *   lib/merge.ts          pure: reconciling rules labels against the LLM's opinion
 *   lib/load.ts           the reads and writes against `recipe_enrichment*`
 *   lib/capture.ts        the `$ai_generation`/disagreement event shapes
 *   lib/posthog.ts         the fail-closed `LLM_ENRICHMENT_FLAG` gate
 *   lib/prompt.ts          the prompt PostHog serves, and the fallback text
 *
 * `fastify.db`, `fastify.ai` and `fastify.posthog` replace this workflow's own
 * former copies of a pool, a provider resolver and a PostHog client — see
 * `plugins/db.ts`, `plugins/ai.ts` and `plugins/posthog.ts`.
 */

const LLM_MAX_OUTPUT_TOKENS = 4096;
const LLM_TIMEOUT_MS = 60_000;

export default fp(
  (fastify) => {
    // --- enrich (entry) ----------------------------------------------------

    function parseEnrichPayload(payload: unknown): { recipeId: string; force: boolean } {
      const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
      const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
      if (!recipeId) {
        throw new UnrecoverableError("enrich job has no recipeId");
      }
      return { recipeId, force: raw.force === true };
    }

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
        const pool = fastify.db;

        const recipe = await loadRecipe(pool, recipeId);
        if (!recipe) {
          await line(`recipe ${recipeId} no longer exists`);
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
          await line(`classified ${lines.length} lines into ${labels.length} labels`);

          try {
            // Best-effort: the durable signal is the recipe_enrichment row this transaction just committed, not this enqueue.
            await enqueue(RECIPE_ENRICHMENT_QUEUE, {
              step: LLM_ENRICH_STEP,
              data: { recipeId, force } satisfies LlmEnrichPayload,
              // llmEnrichJobId makes duplicate triggers for one recipe collapse to one job.
              opts: { jobId: llmEnrichJobId(recipeId) },
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
      },
    };

    // --- llm-enrich ----------------------------------------------------------

    function parseLlmEnrichPayload(payload: unknown): { recipeId: string; force: boolean } {
      const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
      const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
      if (!recipeId) {
        throw new UnrecoverableError("llm-enrich job has no recipeId");
      }
      return { recipeId, force: raw.force === true };
    }

    const llmEnrich: StepSpec = {
      name: LLM_ENRICH_STEP,
      description: "Ask a model for a second opinion on one recipe's labels, and for the dimensions no rule covers",
      jobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
      run: async ({ payload, log: line }) => {
        const { recipeId, force } = parseLlmEnrichPayload(payload);
        const pool = fastify.db;

        // The gate FAILS CLOSED: no PostHog, or the flag not explicitly true, marks the recipe skipped and calls nothing.
        if (!(await isLlmEnrichmentEnabled(fastify.posthog.client, recipeId))) {
          await markLlmSkipped(pool, recipeId);
          await line(`llm enrichment is not enabled for ${recipeId} — skipped`);
          return { status: "skipped" };
        }

        const recipe = await loadRecipe(pool, recipeId);
        if (!recipe) {
          await line(`recipe ${recipeId} no longer exists`);
          return { status: "gone" };
        }

        const inputHash = await fingerprintRecipe(recipe);
        const state = await getLlmEnrichmentState(pool, recipeId);
        if (!rulesPassCurrent(state, inputHash, CLASSIFIER_VERSION)) {
          await markLlmSkipped(pool, recipeId);
          await line(`rules pass for ${recipeId} is missing or stale — skipped; the next enrich re-enqueues this`);
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

          captureGeneration(fastify.posthog.client, {
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

          await line(`llm wrote ${writes.length} labels, ${disagreements.length} disagreements, prompt v${prompt.version ?? "fallback"}`);
          return { status: "ok", labels: writes.length, disagreements: disagreements.length };
        } catch (err) {
          const message = describeWriteError(err);
          fastify.log.error({ recipeId, err: message }, "llm-enrich failed");
          await markLlmError(pool, recipeId, message);
          captureGenerationFailure(fastify.posthog.client, {
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
      },
    };

    fastify.workflow({
      name: RECIPE_ENRICHMENT_QUEUE,
      description: "Derive allergen and diet labels for a recipe's ingredients",
      entry: ENRICH_STEP,
      steps: [enrich, llmEnrich],

      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },

      globalConcurrency: Number(fastify.env.RECIPE_ENRICHMENT_MAX_IN_FLIGHT || 16) || undefined,
    });
  },
  { name: "workflow-recipe-enrichment", dependencies: ["workflow", "db", "posthog", "ai"] },
);
