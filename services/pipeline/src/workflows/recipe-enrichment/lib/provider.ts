import type { LanguageModel } from "ai";

/**
 * The provider registry (llm plan §6.1, L5): `LLM_ENRICHMENT_PROVIDER` picks an
 * entry, the entry turns env into a {@link LanguageModel}. Only `moonshot`
 * ships — Qwen and Gemini are the seam this registry exists for (plan §1.2),
 * not code that lives here today. Adding one later is one more key in
 * {@link PROVIDERS} plus, for a non-OpenAI-compatible provider like Gemini, one
 * more dependency; nothing outside this file is allowed to know which
 * provider is actually running — `classify.ts` takes a `LanguageModel` and
 * never asks where it came from, and `capture.ts`/`merge.ts`'s `method` string
 * are built from {@link ResolvedProvider}'s plain strings, not from a second
 * lookup of their own.
 *
 * **Lazy by construction, not by discipline.** `@ai-sdk/openai-compatible` is
 * `await import`ed inside the `moonshot` entry, never at module top level, so
 * that a process that merely imports this module — `run:once`, `typecheck`,
 * every step file that doesn't happen to reach `llm-enrich` — never pulls the
 * SDK in. This is the same rule the folder doc (plan §4) states for `ai` and
 * every LLM-adjacent dependency, mirroring how the web app treats `pg`: import
 * cost should track whether a code path *runs*, not whether a file merely
 * *exists*. Because the import is async, {@link resolveProvider} is async too
 * — that is a fine price for a function called once per `llm-enrich` job, not
 * once per process boot.
 *
 * **No baked-in model id.** `LLM_ENRICHMENT_MODEL` is read verbatim from env
 * with no fallback constant anywhere in this file. Moonshot renames and
 * retires Kimi model ids; a hardcoded default would go stale silently and
 * keep "working" (against whatever id happened to still resolve) right up
 * until it started failing every job for a reason nobody had to look at in
 * months. An unset or wrong model id is a deploy-time env problem — it should
 * surface as a clear, immediate error someone reads while rolling out, not as
 * a constant this file has to remember to maintain.
 */

/**
 * What a caller needs to run a classification and to describe it afterward.
 * Deliberately one small object instead of returning `LanguageModel` alone:
 * `capture.ts` sends `providerName`/`modelId` as `$ai_provider`/`$ai_model`
 * (plan §10) and `schema.ts`'s `llmMethod(provider, model)` builds the
 * `llm:<provider>:<model>@vN` method string from the same two values (plan
 * L9) — both read them off of this result rather than re-deriving them from
 * env, so there is exactly one place that decides what those strings are.
 */
export interface ResolvedProvider {
  /** The `LLM_ENRICHMENT_PROVIDER` value that resolved — e.g. `"moonshot"`. */
  providerName: string;
  /** `LLM_ENRICHMENT_MODEL`, verbatim, no transformation. */
  modelId: string;
  /**
   * The base URL actually used to reach the provider, for `$ai_base_url`
   * (plan §10) — carried here rather than re-read from env by `capture.ts` so
   * a caller never has to know that `moonshot`'s default lives in this file.
   */
  baseURL: string;
  /** The model instance `classify.ts` hands to `generateObject`. */
  model: LanguageModel;
}

/** The subset of `process.env` a provider factory may read. Matches `NodeJS.ProcessEnv`'s value type without requiring a real `process.env` object in tests. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * One registry entry: env (+ the already-required model id) in, a running
 * model out. Each entry owns its own required-env checks and its own lazy
 * import, so a missing key or a missing SDK dependency fails inside the one
 * entry that needed it, not in a shared preamble that has to know about every
 * provider's requirements at once.
 */
type ProviderFactory = (env: ProviderEnv, modelId: string) => Promise<{ model: LanguageModel; baseURL: string }>;

const PROVIDERS: Readonly<Record<string, ProviderFactory>> = {
  // Moonshot's Kimi API is OpenAI-compatible (plan L5), so `@ai-sdk/openai-compatible`
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
 * Resolve `LLM_ENRICHMENT_PROVIDER` + `LLM_ENRICHMENT_MODEL` (plan §6.1, §11)
 * into a running {@link LanguageModel}, throwing a specific, actionable error
 * for each way the env can be wrong: no provider named, an unrecognized
 * provider name, no model id, or (inside the entry) a missing provider key.
 * Every one of these is a configuration mistake meant to be caught by
 * whoever is standing up the deploy, not retried by BullMQ — `index.ts` is
 * expected to let this throw propagate as a real job failure rather than
 * catching it into a `skipped` row (that outcome is reserved for the flag
 * gate, `lib/posthog.ts`'s job, not this one's).
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
