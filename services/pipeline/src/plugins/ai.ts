import fp from "fastify-plugin";
import { resolveProvider, type ResolvedProvider } from "#/lib/ai/provider.ts";
import { modelRawText } from "#/lib/ai/errors.ts";

/**
 * The generic AI surface: provider resolution, and reading the model's raw
 * text back out of a schema-validation rejection.
 *
 * `captureGeneration` is GONE, along with `lib/ai/capture.ts`'s hand-built
 * `$ai_generation` builder. PostHog gets generations from the AI SDK's own
 * OpenTelemetry spans now — see `plugins/telemetry.ts` for why the manual path
 * could not stay and why the model-wrapper alternative is unavailable on AI
 * SDK v7. What is left of "AI" that is genuinely generic is small, and this is
 * it.
 *
 * Prompt fetching moved to `fastify.posthog.fetchPrompt` (S1a) — a `Prompts`
 * client takes PostHog credentials and talks to a PostHog host, so it is a
 * PostHog concern, not an AI-provider one. This plugin no longer builds a
 * `Prompts` client or reads any `POSTHOG_*` env var itself; see
 * `plugins/posthog.ts` for why the two PostHog clients live together.
 *
 * What stays out of `fastify.ai` on purpose, because it knows what a recipe
 * is: the domain events in `queues/recipe-enrichment/lib/capture.ts`,
 * `AI_FEATURE`, `PROMPT_NAME`, `LLM_ENRICHMENT_FLAG`, `buildRecipeJson`.
 * Those remain queue-owned. The per-call telemetry OPTIONS builder is the
 * borderline case and went generic (`lib/ai/telemetry.ts`): its shape is
 * about the AI SDK, not about recipes.
 */
export interface AiService {
  /** Resolve `LLM_ENRICHMENT_PROVIDER`/`LLM_ENRICHMENT_MODEL` into a running model. Reads `process.env` directly, same as the source module. */
  resolveProvider(): Promise<ResolvedProvider>;
  /** The model's raw text when `err` is a schema-validation rejection. */
  modelRawText(err: unknown): string | undefined;
}

export default fp(
  (fastify) => {
    const ai: AiService = {
      resolveProvider: () => resolveProvider(),
      modelRawText,
    };

    fastify.decorate("ai", ai);
  },
  { name: "ai", dependencies: ["env"] },
);

declare module "fastify" {
  interface FastifyInstance {
    ai: AiService;
  }
}
