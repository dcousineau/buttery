import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

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
 * {@link LanguageModel}. Only `openrouter` ships — a direct-to-vendor entry is
 * the seam this registry exists for, not code that lives here today.
 *
 * **Why a gateway and not a vendor.** OpenRouter fronts every model behind one
 * key and one base URL, so changing WHICH model runs is an
 * `LLM_ENRICHMENT_MODEL` edit rather than a new registry entry, a new
 * dependency and a new secret. The registry keeps earning its keep for the
 * case a vendor has to be reached directly (rate limits, a model OpenRouter
 * does not carry, data residency), which is exactly when a second entry is
 * cheap to add.
 *
 * **Lazy by construction, not by discipline.** `@openrouter/ai-sdk-provider`
 * is `await import`ed inside the `openrouter` entry, never at module top
 * level, so that a process that merely imports this module never pulls the SDK
 * in.
 *
 * **No baked-in model id.** `LLM_ENRICHMENT_MODEL` is read verbatim from env
 * with no fallback constant anywhere in this file — an unset or wrong model
 * id is a deploy-time env problem that should surface as a clear, immediate
 * error, not a stale hardcoded default.
 *
 * **An entry may also carry per-request options**, because "how you call this
 * provider" is the same kind of fact as "where you call it" — see
 * {@link ResolvedProvider.providerOptions}.
 */

/**
 * What a caller needs to run a generation and to describe it afterward
 * (`$ai_provider`/`$ai_model`, an `llm:<provider>:<model>@vN` method string,
 * etc.) — one small object instead of `LanguageModel` alone, so there is
 * exactly one place that decides what those strings are.
 */
export interface ResolvedProvider {
  /** The `LLM_ENRICHMENT_PROVIDER` value that resolved — e.g. `"openrouter"`. */
  providerName: string;
  /** `LLM_ENRICHMENT_MODEL`, verbatim, no transformation. */
  modelId: string;
  /** The base URL actually used to reach the provider. */
  baseURL: string;
  /** The model instance a caller hands to `generateText`/`generateObject`. */
  model: LanguageModel;
  /**
   * Passed straight to `generateText`'s `providerOptions`, keyed by provider
   * name — the AI SDK routes each key to the provider that answers to it.
   *
   * This exists so a registry entry can state how its model must be CALLED,
   * not just where it lives — the caller should not have to know that one
   * provider needs a knob turned and another does not. Empty for `openrouter`:
   * every knob it offers (`reasoning`, `models` fallback routing, `user`) is
   * either irrelevant to a non-reasoning instruct model or a routing policy
   * this workload has not needed to state.
   */
  providerOptions: ProviderOptions;
}

/** The subset of `process.env` a provider factory may read. Matches `NodeJS.ProcessEnv`'s value type without requiring a real `process.env` object in tests. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * One registry entry: env (+ the already-required model id) in, a running
 * model out. Each entry owns its own required-env checks and its own lazy
 * import, so a missing key or a missing SDK dependency fails inside the one
 * entry that needed it.
 */
type ProviderFactory = (env: ProviderEnv, modelId: string) => Promise<{ model: LanguageModel; baseURL: string; providerOptions: ProviderOptions }>;

const PROVIDERS: Readonly<Record<string, ProviderFactory>> = {
  openrouter: async (env, modelId) => {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LLM_ENRICHMENT_PROVIDER=openrouter but OPENROUTER_API_KEY is not set — set it in the pipeline env (services/pipeline/.env.example) before llm-enrich can run",
      );
    }
    // `||`, not `??`: `.env.example` ships `OPENROUTER_BASE_URL=` blank on purpose, and
    // `process.loadEnvFile` reads that as `""` — which is a URL nothing can parse, not an absence.
    const baseURL = env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    // `strict` because this really is the OpenRouter API and not a third party
    // wearing its shape; `compatible` (the factory default) holds newer request
    // fields back for that latter case. `appName` is app attribution on the
    // openrouter.ai dashboard — it rides as a header and reaches no model.
    const provider = createOpenRouter({ apiKey, baseURL, compatibility: "strict", appName: "buttery-pipeline" });
    return { model: provider.chat(modelId), baseURL, providerOptions: {} };
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
    throw new Error('LLM_ENRICHMENT_PROVIDER is not set — set it (e.g. "openrouter") in the pipeline env before llm-enrich can run');
  }
  const factory = PROVIDERS[providerName];
  if (!factory) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new Error(`unknown LLM_ENRICHMENT_PROVIDER "${providerName}" — known providers: ${known}`);
  }
  const modelId = env.LLM_ENRICHMENT_MODEL;
  if (!modelId) {
    throw new Error(
      "LLM_ENRICHMENT_MODEL is not set — this file deliberately keeps no default, so a missing or wrong id is a loud deploy-time error rather than a stale constant; " +
        'set it to a routing slug from openrouter.ai/models (e.g. "mistralai/mistral-small-24b-instruct-2501")',
    );
  }
  const { model, baseURL, providerOptions } = await factory(env, modelId);
  return { providerName, modelId, baseURL, model, providerOptions };
}
