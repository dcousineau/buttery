import fp from "fastify-plugin";
import { resolveProvider, type ResolvedProvider } from "#/lib/ai/provider.ts";
import { captureAiGeneration, type AiGenerationEventInput } from "#/lib/ai/capture.ts";
import { modelRawText } from "#/lib/ai/errors.ts";

/**
 * The generic AI surface (S1, trimmed in S1a): provider resolution and
 * `$ai_generation` capture, with `fastify.posthog.client` already bound so a
 * caller never threads it through itself.
 *
 * Prompt fetching moved to `fastify.posthog.fetchPrompt` (S1a) — a `Prompts`
 * client takes PostHog credentials and talks to a PostHog host, so it is a
 * PostHog concern, not an AI-provider one. This plugin no longer builds a
 * `Prompts` client or reads any `POSTHOG_*` env var itself; see
 * `plugins/posthog.ts` for why the two PostHog clients live together.
 *
 * Everything here is the `src/lib/ai/` extraction named in the plan's
 * Phase-1 paragraph. **Nothing consumes this yet** — the recipe-enrichment
 * workflow still calls its own
 * `workflows/recipe-enrichment/lib/{provider,capture,posthog}.ts` copies
 * unchanged, which this plugin's helpers were copied *from*, not moved from.
 * A later step repoints that workflow at `fastify.ai` and deletes the
 * originals.
 *
 * What stays out of `fastify.ai` on purpose, because it knows what a recipe
 * is: `captureGeneration`/`captureGenerationFailure`, the disagreement
 * event, `AI_FEATURE`, `PROMPT_NAME`, `LLM_ENRICHMENT_FLAG`,
 * `buildRecipeJson`. Those remain workflow-owned.
 */
export interface AiService {
  /** Resolve `LLM_ENRICHMENT_PROVIDER`/`LLM_ENRICHMENT_MODEL` into a running model. Reads `process.env` directly, same as the source module. */
  resolveProvider(): Promise<ResolvedProvider>;
  /** Capture one `$ai_generation` event through `fastify.posthog.client`, whatever that decorator currently is (including `null`). */
  captureGeneration(input: AiGenerationEventInput): void;
  /** The model's raw text when `err` is a schema-validation rejection. */
  modelRawText(err: unknown): string | undefined;
}

export default fp(
  (fastify) => {
    const ai: AiService = {
      resolveProvider: () => resolveProvider(),
      captureGeneration: (input) => captureAiGeneration(fastify.posthog.client, input),
      modelRawText,
    };

    fastify.decorate("ai", ai);
  },
  { name: "ai", dependencies: ["env", "posthog"] },
);

declare module "fastify" {
  interface FastifyInstance {
    ai: AiService;
  }
}
