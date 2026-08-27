import { Prompts, type PromptResult } from "@posthog/ai";
import { FALLBACK_PROMPT, PROMPT_NAME } from "#/workflows/recipe-enrichment/llm/prompt.ts";

/**
 * PostHog Prompt Management fetch (plan §6.2) — resolves the `production`
 * label of the `recipe-llm-enrichment` prompt at runtime, falling back to
 * `prompt.ts`'s committed text whenever PostHog cannot answer.
 *
 * ── This is the official client now; it used to be hand-rolled REST ─────────
 *
 * The plan's §6.2 says to try `import { Prompts } from "posthog-node"` and to
 * implement the same contract over REST if that export is absent. It IS absent
 * from `posthog-node@5.49.1`, so this file was originally ~130 lines of hand-
 * rolled REST: a URL guess, a response-shape guess with four candidate field
 * names, a module-level TTL cache, and a prominent UNVERIFIED-AGAINST-LIVE-
 * POSTHOG warning. The `Prompts` class lives in a DIFFERENT package,
 * `@posthog/ai`, which the plan never names here — and all of that guesswork
 * is now deleted in favour of it.
 *
 * That deletion is the point: the response shape is the vendor's problem
 * again, not a documented assumption we were carrying into production hoping
 * to be right. It also buys three things the hand-rolled version did not have:
 * `source: 'stale_cache'` (serve the last good prompt when the API is down,
 * rather than dropping to the committed fallback), per-prompt cache
 * invalidation, and a `version` that is whatever PostHog says rather than
 * whichever of `version`/`version_number` happened to exist.
 *
 * This does NOT contradict plan L7. That decision rejects `@posthog/ai`'s
 * **OTel span processor** for `$ai_generation` capture, and that rejection
 * stands — `capture.ts` still builds its own event. The OTel machinery is a
 * separate subpath (`@posthog/ai/otel`) with its own peer dependencies; the
 * root entry this imports pulls in only `@posthog/core` and `uuid`, verified
 * against the built `dist/index.mjs` rather than assumed, so no OTel stack
 * reaches the worker.
 *
 * ── App host vs. ingestion host ─────────────────────────────────────────────
 * `Prompts` talks to the APP host (`https://us.posthog.com`) with a PERSONAL
 * API key (`POSTHOG_PERSONAL_API_KEY`, scope `llm_prompt:read`) — a human
 * identity, because prompt content is a workspace asset, not an event. That is
 * deliberately different from `llm/posthog.ts`'s event capture and flag
 * evaluation, which use the PROJECT token against the INGESTION host
 * (`https://us.i.posthog.com`, `POSTHOG_HOST`). Both credentials are needed
 * here: the personal key authenticates, the project token selects the project.
 */

/**
 * How long the SDK reuses a fetched prompt before going back to the API. Plan
 * §6.2: "a prompt fetch must never be the slow part" of a job, so most
 * `llm-enrich` runs pay nothing for this — they hit the SDK's cache — while a
 * PostHog prompt edit still reaches the pipeline within five minutes of
 * someone moving the `production` label.
 */
export const PROMPT_CACHE_TTL_SECONDS = 300;

/**
 * Budget for the fetch itself (plan §6.2), enforced here because `Prompts.get`
 * takes no timeout of its own.
 *
 * A prompt fetch competes with nothing in `llm-enrich`'s critical path worth
 * waiting seconds for — if PostHog is slow, the committed fallback is a better
 * outcome than a stalled job, which is why this is so tight next to the 60s
 * `classify.ts` gives the model call. The losing fetch is deliberately NOT
 * aborted: it keeps running and populates the SDK's cache, so the run after a
 * slow one usually gets the real prompt for free.
 */
const FETCH_TIMEOUT_MS = 2000;

/** PostHog's app host (plan §5.2). Overridable only so a test or a future staging host needs no code change; `.env.example` documents the ingestion `POSTHOG_HOST` separately. */
const DEFAULT_POSTHOG_APP_HOST = "https://us.posthog.com";

export interface ResolvedPrompt {
  /** The prompt template, still carrying `{{recipe_json}}` — `classify.ts` compiles it. */
  text: string;
  /** The prompt name PostHog resolved, or `prompt.ts`'s `PROMPT_NAME` on a fallback. Sent as `$ai_prompt_name`. */
  name: string;
  /** The PostHog version used, or `null` when the committed fallback was used instead — recorded verbatim in `recipe_enrichment.llm_prompt_version` (plan §6.2) so "which recipes ran on the fallback" is a query, not a mystery. Sent as `$ai_prompt_version`. */
  version: number | null;
  /** The SDK's own provenance for this resolution: `api`, `cache`, `stale_cache`, or `code_fallback`. Logged, not stored — it answers "is PostHog actually reachable from the workers?" without a second instrument. */
  source: PromptResult["source"];
}

/**
 * The one method of `Prompts` this module uses, as a structural type.
 *
 * Tests inject a fake shaped like this rather than a real client, which is what
 * keeps L11 true — no test in this package may make a live PostHog call, and
 * the only way to be sure is for the tested path never to construct a real
 * client at all.
 */
export interface PromptsClient {
  get(name: string, options?: { label?: string; cacheTtlSeconds?: number; fallback?: string }): Promise<PromptResult>;
}

export interface PromptFetchDeps {
  /** Defaults to a lazily-constructed real `Prompts`. Pass `null` to force the no-client path (what an unconfigured environment hits). */
  client?: PromptsClient | null;
  /** Defaults to `process.env`. Tests inject a plain object so env state from one case cannot leak into the next. */
  env?: Record<string, string | undefined>;
}

let memoizedClient: PromptsClient | null | undefined;
let warnedMissingConfig = false;

/** Drops the memoized client (and with it the SDK's cache). Tests call this between cases; production never needs it — `cacheTtlSeconds` is what expires a prompt there. */
export function resetPromptCache(): void {
  memoizedClient = undefined;
  warnedMissingConfig = false;
}

function warn(message: string, err?: unknown): void {
  if (err === undefined) console.warn(`[llm/prompt-fetch] ${message}`);
  else console.warn(`[llm/prompt-fetch] ${message}`, err);
}

/**
 * Build the `Prompts` client once per process, or `null` when this environment
 * is not configured for prompt management.
 *
 * `PromptsDirectOptions` rather than `{ posthog }` on purpose: the client in
 * `llm/posthog.ts` is gated by `POSTHOG_ENABLED` and carries no personal key,
 * and prompt fetching is a different question from event capture with a
 * different credential. Reusing that client would tie "can we read the prompt?"
 * to "may we write events?", which are allowed to differ — most visibly when
 * `LLM_ENRICHMENT_ENABLED=true` overrides the flag in an environment with no
 * capture client at all.
 */
function getClient(env: Record<string, string | undefined>): PromptsClient | null {
  if (memoizedClient !== undefined) return memoizedClient;

  const personalApiKey = env.POSTHOG_PERSONAL_API_KEY;
  const projectApiKey = env.POSTHOG_PROJECT_TOKEN;
  if (!personalApiKey || !projectApiKey) {
    if (!warnedMissingConfig) {
      // Once per process, not once per job: an unconfigured environment is the
      // COMMON case (every dev machine), and this whole module exists to
      // degrade quietly from it — a warning per recipe would be noise at
      // corpus volume.
      warn("POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_TOKEN not configured; using the committed fallback prompt");
      warnedMissingConfig = true;
    }
    memoizedClient = null;
    return null;
  }

  memoizedClient = new Prompts({
    personalApiKey,
    projectApiKey,
    host: env.POSTHOG_APP_HOST ?? DEFAULT_POSTHOG_APP_HOST,
    defaultCacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
  });
  return memoizedClient;
}

/** What every failure path returns. `version: null` is the queryable record that this run did not use a PostHog prompt. */
const CODE_FALLBACK: ResolvedPrompt = { text: FALLBACK_PROMPT, name: PROMPT_NAME, version: null, source: "code_fallback" };

/**
 * Resolve the prompt `classify.ts` should compile with `{{recipe_json}}`
 * (plan §6.2).
 *
 * Never throws. Every failure — no credentials, a non-200, a timeout, an
 * unreachable PostHog — resolves to `FALLBACK_PROMPT` with `version: null`.
 * The SDK's own `fallback` option covers the failures it can see; the race
 * below covers the one it cannot (taking too long).
 */
export async function fetchPrompt(deps: PromptFetchDeps = {}): Promise<ResolvedPrompt> {
  const env = deps.env ?? process.env;
  const client = deps.client === undefined ? getClient(env) : deps.client;
  if (!client) return CODE_FALLBACK;

  // `Symbol` rather than a sentinel object so the timeout branch can never be
  // confused with a legitimate (if bizarre) resolution value.
  const timedOut = Symbol("prompt-fetch-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      client.get(PROMPT_NAME, {
        label: "production",
        cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
        // The SDK resolves this itself and reports `source: 'code_fallback'`,
        // so an API failure never reaches the catch below — it comes back as
        // an ordinary result that simply carries no version.
        fallback: FALLBACK_PROMPT,
      }),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), FETCH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (result === timedOut) {
      warn(`prompt fetch exceeded ${FETCH_TIMEOUT_MS}ms; using the committed fallback prompt (the in-flight fetch still warms the SDK cache)`);
      return CODE_FALLBACK;
    }

    return {
      text: result.prompt,
      // `name`/`version` are `undefined` on the SDK's own fallback result and
      // `string`/`number` otherwise — normalized here so every consumer sees
      // one shape and `llm_prompt_version` gets a real null.
      name: result.name ?? PROMPT_NAME,
      version: result.version ?? null,
      source: result.source,
    };
  } catch (err) {
    // The SDK's `fallback` already absorbs API failures, so reaching this means
    // something more unusual (a bad client construction, a bug in the SDK).
    // Degrade anyway: a prompt fetch must never be what fails a job.
    warn("prompt fetch threw; using the committed fallback prompt", err);
    return CODE_FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}
