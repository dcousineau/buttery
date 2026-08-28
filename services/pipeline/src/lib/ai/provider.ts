import type { LanguageModel } from "ai";

/**
 * The provider registry (llm plan §6.1, L5), copied here verbatim from
 * `workflows/recipe-enrichment/lib/provider.ts` for `plugins/ai.ts` (S1).
 * This is a **copy, not a move** — the original stays in place and keeps
 * serving `recipe-enrichment/index.ts` unchanged; a later step deletes it
 * once that workflow is repointed at `fastify.ai`. There was nothing
 * recipe-specific in the original to begin with: `resolveProvider` reads
 * env and returns a running model, and knows nothing about recipes,
 * ingredients or labels.
 *
 * `LLM_ENRICHMENT_PROVIDER` picks an entry, the entry turns env into a
 * {@link LanguageModel}. Only `moonshot` ships — Qwen and Gemini are the seam
 * this registry exists for, not code that lives here today.
 *
 * **Lazy by construction, not by discipline.** `@ai-sdk/openai-compatible` is
 * `await import`ed inside the `moonshot` entry, never at module top level, so
 * that a process that merely imports this module never pulls the SDK in.
 *
 * **No baked-in model id.** `LLM_ENRICHMENT_MODEL` is read verbatim from env
 * with no fallback constant anywhere in this file — an unset or wrong model
 * id is a deploy-time env problem that should surface as a clear, immediate
 * error, not a stale hardcoded default.
 */

/**
 * What a caller needs to run a generation and to describe it afterward
 * (`$ai_provider`/`$ai_model`, an `llm:<provider>:<model>@vN` method string,
 * etc.) — one small object instead of `LanguageModel` alone, so there is
 * exactly one place that decides what those strings are.
 */
export interface ResolvedProvider {
  /** The `LLM_ENRICHMENT_PROVIDER` value that resolved — e.g. `"moonshot"`. */
  providerName: string;
  /** `LLM_ENRICHMENT_MODEL`, verbatim, no transformation. */
  modelId: string;
  /** The base URL actually used to reach the provider. */
  baseURL: string;
  /** The model instance a caller hands to `generateText`/`generateObject`. */
  model: LanguageModel;
}

/** The subset of `process.env` a provider factory may read. Matches `NodeJS.ProcessEnv`'s value type without requiring a real `process.env` object in tests. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * One registry entry: env (+ the already-required model id) in, a running
 * model out. Each entry owns its own required-env checks and its own lazy
 * import, so a missing key or a missing SDK dependency fails inside the one
 * entry that needed it.
 */
type ProviderFactory = (env: ProviderEnv, modelId: string) => Promise<{ model: LanguageModel; baseURL: string }>;

const PROVIDERS: Readonly<Record<string, ProviderFactory>> = {
  // Moonshot's Kimi API is OpenAI-compatible, so `@ai-sdk/openai-compatible`
  // is the entire dependency — no `@ai-sdk/moonshot` exists or needs to.
  moonshot: async (env, modelId) => {
    const apiKey = env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error("LLM_ENRICHMENT_PROVIDER=moonshot but MOONSHOT_API_KEY is not set — set it in the pipeline env (services/pipeline/.env.example) before llm-enrich can run");
    }
    const baseURL = env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const provider = createOpenAICompatible({ name: "moonshot", baseURL, apiKey });
    return { model: provider.chatModel(modelId), baseURL };
  },
};

/**
 * Resolve `LLM_ENRICHMENT_PROVIDER` + `LLM_ENRICHMENT_MODEL` into a running
 * {@link LanguageModel}, throwing a specific, actionable error for each way
 * the env can be wrong: no provider named, an unrecognized provider name, no
 * model id, or (inside the entry) a missing provider key. Every one of these
 * is a configuration mistake meant to be caught by whoever is standing up
 * the deploy, not retried by BullMQ.
 *
 * `env` defaults to `process.env` and is otherwise only ever overridden by
 * tests — production code should call `resolveProvider()` with no argument.
 */
export async function resolveProvider(env: ProviderEnv = process.env): Promise<ResolvedProvider> {
  const providerName = env.LLM_ENRICHMENT_PROVIDER;
  if (!providerName) {
    throw new Error('LLM_ENRICHMENT_PROVIDER is not set — set it (e.g. "moonshot") in the pipeline env before llm-enrich can run');
  }
  const factory = PROVIDERS[providerName];
  if (!factory) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new Error(`unknown LLM_ENRICHMENT_PROVIDER "${providerName}" — known providers: ${known}`);
  }
  const modelId = env.LLM_ENRICHMENT_MODEL;
  if (!modelId) {
    throw new Error(
      "LLM_ENRICHMENT_MODEL is not set — Moonshot renames model ids, so this file deliberately has no default; " +
        'set it to the current id from platform.moonshot.ai (e.g. "kimi-k2-0905-preview", verified against the platform, not hardcoded here)',
    );
  }
  const { model, baseURL } = await factory(env, modelId);
  return { providerName, modelId, baseURL, model };
}
