import type { PromptResult } from "@posthog/ai";

/**
 * PostHog Prompt Management fetch, generalized here for `plugins/posthog.ts`
 * (S1a, moved from `plugins/ai.ts`'s S1 landing) from
 * `workflows/recipe-enrichment/lib/prompt-fetch.ts` — the original stays in
 * place and keeps serving `recipe-enrichment/index.ts` unchanged.
 *
 * The one real change from the source module, beyond the copy: the original
 * hardcodes `recipe-enrichment/lib/prompt.ts`'s `PROMPT_NAME`/`FALLBACK_PROMPT`
 * and memoizes its `Prompts` client in module-scope state (`memoizedClient`).
 * Neither is allowed here — `PROMPT_NAME` is recipe-specific and stays
 * workflow-owned (D0 says `lib/` holds no process-global mutable state
 * either), so this version takes the prompt name and fallback text as
 * arguments, and takes an already-built client as an argument rather than
 * building and caching one itself. `plugins/posthog.ts` builds the client
 * once at boot and passes it into {@link fetchPrompt} on every call — the TTL
 * cache lives inside the SDK itself via `cacheTtlSeconds`, so there is
 * nothing left for this module to memoize.
 *
 * ── App host vs. ingestion host ─────────────────────────────────────────────
 * `Prompts` talks to the APP host (`https://us.posthog.com`) with a PERSONAL
 * API key (`POSTHOG_PERSONAL_API_KEY`, scope `llm_prompt:read`) — a human
 * identity, because prompt content is a workspace asset, not an event. That
 * is deliberately different from `plugins/posthog.ts`'s event-capture client,
 * which uses the PROJECT token against the INGESTION host
 * (`https://us.i.posthog.com`, `POSTHOG_HOST`). Both credentials are needed
 * here: the personal key authenticates, the project token selects the
 * project. That contrast is why both clients live in one plugin — see
 * `plugins/posthog.ts` for the client construction and its `PostHogService`
 * decorator; this module stays a pure function of an already-built client.
 */

/**
 * How long the SDK reuses a fetched prompt before going back to the API. A
 * prompt fetch must never be the slow part of a job, so most runs pay
 * nothing for this — they hit the SDK's cache — while a PostHog prompt edit
 * still reaches the pipeline within five minutes of someone moving the
 * `production` label.
 */
export const PROMPT_CACHE_TTL_SECONDS = 300;

/**
 * Budget for the fetch itself, enforced here because `Prompts.get` takes no
 * timeout of its own. The losing fetch is deliberately NOT aborted: it keeps
 * running and populates the SDK's cache, so the run after a slow one usually
 * gets the real prompt for free.
 */
const FETCH_TIMEOUT_MS = 2000;

export interface ResolvedPrompt {
  /** The prompt template, still carrying whatever compile-time variable the caller's prompt uses. */
  text: string;
  /** The prompt name PostHog resolved, or the caller's `name` argument on a fallback. */
  name: string;
  /** The PostHog version used, or `null` when the caller's fallback text was used instead. */
  version: number | null;
  /** The SDK's own provenance for this resolution: `api`, `cache`, `stale_cache`, or `code_fallback`. */
  source: PromptResult["source"];
}

/**
 * The one method of `Prompts` this module uses, as a structural type — lets
 * a caller inject a fake shaped like this instead of a real client.
 */
export interface PromptsClient {
  get(name: string, options?: { label?: string; cacheTtlSeconds?: number; fallback?: string }): Promise<PromptResult>;
}

/**
 * Resolve the named prompt. Never throws. Every failure — no client, a
 * non-200, a timeout, an unreachable PostHog — resolves to `fallbackText`
 * with `version: null`. The SDK's own `fallback` option covers the failures
 * it can see; the race below covers the one it cannot (taking too long).
 */
export async function fetchPrompt(client: PromptsClient | null, name: string, fallbackText: string): Promise<ResolvedPrompt> {
  const codeFallback: ResolvedPrompt = { text: fallbackText, name, version: null, source: "code_fallback" };
  if (!client) return codeFallback;

  // `Symbol` rather than a sentinel object so the timeout branch can never be
  // confused with a legitimate (if bizarre) resolution value.
  const timedOut = Symbol("prompt-fetch-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      client.get(name, {
        label: "production",
        cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
        // The SDK resolves this itself and reports `source: 'code_fallback'`,
        // so an API failure never reaches the catch below.
        fallback: fallbackText,
      }),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), FETCH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (result === timedOut) {
      return codeFallback;
    }

    return {
      text: result.prompt,
      // `name`/`version` are `undefined` on the SDK's own fallback result and
      // `string`/`number` otherwise — normalized here so every caller sees
      // one shape.
      name: result.name ?? name,
      version: result.version ?? null,
      source: result.source,
    };
  } catch {
    // The SDK's `fallback` already absorbs API failures, so reaching this
    // means something more unusual (a bad client construction, a bug in the
    // SDK). Degrade anyway: a prompt fetch must never be what fails a job.
    return codeFallback;
  } finally {
    clearTimeout(timer);
  }
}
