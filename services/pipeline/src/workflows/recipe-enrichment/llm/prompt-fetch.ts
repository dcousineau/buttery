import { FALLBACK_PROMPT, PROMPT_NAME } from "#/workflows/recipe-enrichment/llm/prompt.ts";

/**
 * PostHog Prompt Management fetch (plan §6.2) — resolves the `production`
 * label of the `recipe-llm-enrichment` prompt at runtime, with an in-memory
 * cache and a fallback to `prompt.ts`'s committed text on any failure.
 *
 * ── Why REST, not the `posthog-node` SDK ────────────────────────────────────
 * The plan's first choice was `import { Prompts } from "posthog-node"`. The
 * installed version here is `posthog-node@5.49.1`, and it ships no `Prompts`
 * export at all — checked directly against that package's `.d.ts` files, not
 * assumed from the docs (agents have no live PostHog access to double-check
 * behavior against, plan intro constraint 2, so the type declarations are the
 * only ground truth available). This file therefore implements the plan's
 * documented fallback: the same contract over the REST endpoint PostHog's
 * prompt UI itself calls.
 *
 * ── App host vs. ingestion host ─────────────────────────────────────────────
 * This hits `https://us.posthog.com` (the APP host) with a PERSONAL API key
 * (`POSTHOG_PERSONAL_API_KEY`, scope `llm_prompt:read`) — a human identity,
 * used because prompt content is a workspace asset, not an event. That is
 * deliberately different from `llm/posthog.ts`'s event capture and flag
 * evaluation, which talk to the INGESTION host (`https://us.i.posthog.com` by
 * default, `POSTHOG_HOST`) with the PROJECT token — see plan §5.2 and §11 for
 * why the two paths use different hosts and different credentials.
 */

/**
 * How long a resolved prompt (fetched OR fallen back to) is reused before the
 * next `fetchPrompt` call re-fetches. Plan §6.2: "a prompt fetch must never be
 * the slow part" of a job, so most `llm-enrich` runs pay nothing for this —
 * they hit the cache — while a PostHog prompt edit still reaches the pipeline
 * within five minutes of moving the `production` label.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Budget for the network call itself (plan §6.2). A prompt fetch competes
 * with nothing else in `llm-enrich`'s critical path worth waiting seconds
 * for — if PostHog is slow, the fallback is a better outcome than a stalled
 * job, so this is intentionally tight next to the 60s budget `classify.ts`
 * gives the model call itself.
 */
const FETCH_TIMEOUT_MS = 2000;

/** PostHog's app host (plan §5.2) — not configurable via `.env.example` (only the ingestion `POSTHOG_HOST` is); overridable here only so a test or a future staging host doesn't need a code change. */
const DEFAULT_POSTHOG_APP_HOST = "https://us.posthog.com";

export interface ResolvedPrompt {
  /** The prompt text to compile with `{{recipe_json}}` and send as the system message. */
  text: string;
  /** The PostHog prompt version actually used, or `null` when `FALLBACK_PROMPT` was used instead — recorded verbatim in `recipe_enrichment.llm_prompt_version` (plan §6.2) so "which recipes ran on the fallback" is a query, not a mystery. */
  version: number | null;
}

/**
 * Injected seams for tests (L11: the fallback path is the tested-by-default
 * path, and nothing here may make a live network call in a test). All three
 * are optional and default to the real thing, so `fetchPrompt()` with no
 * arguments is exactly what `classify.ts` calls in production.
 */
export interface PromptFetchDeps {
  /** Defaults to the global `fetch`. Tests inject a fake and assert call counts against it — never a real network call. */
  fetchImpl?: typeof fetch;
  /** Defaults to `Date.now`. Tests inject a fake clock to exercise the cache TTL without a real 5-minute wait. */
  now?: () => number;
  /** Defaults to `process.env`. Tests inject a plain object so env state from one test can't leak into the next. */
  env?: Record<string, string | undefined>;
}

let cache: { result: ResolvedPrompt; fetchedAtMs: number } | null = null;

/** Drops the cached prompt. Tests call this between cases so one test's fetch (or fallback) never leaks into the next — production code never needs it (the TTL is what expires the cache there). */
export function resetPromptCache(): void {
  cache = null;
}

function warn(message: string, err?: unknown): void {
  if (err === undefined) console.warn(`[llm/prompt-fetch] ${message}`);
  else console.warn(`[llm/prompt-fetch] ${message}`, err);
}

/**
 * Pull `{ text, version }` out of PostHog's "resolve prompt by name" REST
 * response.
 *
 * ── UNVERIFIED-AGAINST-LIVE-POSTHOG ─────────────────────────────────────────
 * Implementing agents have no PostHog access (plan intro constraint 2) and
 * have never seen a real response from
 * `GET /api/projects/{id}/llm_prompts/resolve/name/{name}/?label=production`.
 * This function is written against the most plausible shape for a "resolved
 * prompt" — compiled text plus a `version` integer — with a couple of
 * documented fallback field names for the cases most likely to be right
 * instead of the first guess:
 *
 *   text:    `body.prompt` (string) — or `body.content`, if it is a string —
 *            or, if `body.content` is an array of chat-style
 *            `{ role, content }` messages (PostHog's prompt editor is
 *            chat-shaped even for a single-turn "system" prompt), the joined
 *            `content` strings of each entry — or `body.text` (string).
 *   version: `body.version` — or `body.version_number`.
 *
 * Any shape that doesn't produce a non-empty string for text is treated as
 * unrecognized and falls back to `FALLBACK_PROMPT` (never throws — an
 * unexpected shape must degrade, not crash `fetchPrompt`). **Whoever gets
 * real PostHog access first: hit this endpoint once, diff the actual response
 * against the branches below, delete whichever guesses were wrong, and remove
 * this notice.**
 */
function extractPrompt(body: unknown): ResolvedPrompt | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  let text: string | null = null;
  if (typeof record.prompt === "string") {
    text = record.prompt;
  } else if (typeof record.content === "string") {
    text = record.content;
  } else if (Array.isArray(record.content)) {
    const parts = record.content
      .map((entry) => {
        if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>).content === "string") {
          return (entry as Record<string, unknown>).content as string;
        }
        return null;
      })
      .filter((part): part is string => part !== null);
    if (parts.length > 0) text = parts.join("\n\n");
  } else if (typeof record.text === "string") {
    text = record.text;
  }
  if (text === null || text.length === 0) return null;

  const versionRaw = record.version ?? record.version_number;
  const version = typeof versionRaw === "number" && Number.isFinite(versionRaw) ? versionRaw : null;

  return { text, version };
}

/** The one network attempt, isolated from caching so `fetchPrompt` only has to reason about the TTL. Never throws — every failure mode resolves to the fallback. */
async function resolvePrompt(deps: PromptFetchDeps): Promise<ResolvedPrompt> {
  const env = deps.env ?? process.env;
  const personalKey = env.POSTHOG_PERSONAL_API_KEY;
  const projectId = env.POSTHOG_PROJECT_ID;
  if (!personalKey || !projectId) {
    // Not a failure worth escalating — most dev/test environments simply
    // don't carry these, and that's the expected, common case this whole
    // module exists to degrade gracefully from (plan intro constraint 2).
    warn("POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not configured; using fallback prompt");
    return { text: FALLBACK_PROMPT, version: null };
  }

  const appHost = env.POSTHOG_APP_HOST ?? DEFAULT_POSTHOG_APP_HOST;
  const url = `${appHost}/api/projects/${projectId}/llm_prompts/resolve/name/${PROMPT_NAME}/?label=production`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${personalKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      warn(`prompt fetch returned ${res.status}; using fallback prompt`);
      return { text: FALLBACK_PROMPT, version: null };
    }
    const body: unknown = await res.json();
    const parsed = extractPrompt(body);
    if (!parsed) {
      warn("prompt fetch response had an unrecognized shape; using fallback prompt");
      return { text: FALLBACK_PROMPT, version: null };
    }
    return parsed;
  } catch (err) {
    // Covers network errors, `AbortSignal.timeout`'s abort, and a body that
    // isn't valid JSON — one catch because all three mean the same thing
    // here: PostHog wasn't reachable in time with something usable.
    warn("prompt fetch failed; using fallback prompt", err);
    return { text: FALLBACK_PROMPT, version: null };
  }
}

/**
 * Resolve the prompt text `classify.ts` should compile with `{{recipe_json}}`
 * (plan §6.2). Tries PostHog's `production`-labeled `recipe-llm-enrichment`
 * prompt over REST, cached for `PROMPT_CACHE_TTL_MS`; falls back to
 * `FALLBACK_PROMPT` with `version: null` on ANY failure — no key configured,
 * no project id, a non-200, a timeout, a malformed body, a network error.
 * Never throws.
 */
export async function fetchPrompt(deps: PromptFetchDeps = {}): Promise<ResolvedPrompt> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  if (cache && nowMs - cache.fetchedAtMs < PROMPT_CACHE_TTL_MS) {
    return cache.result;
  }

  const result = await resolvePrompt(deps);
  cache = { result, fetchedAtMs: nowMs };
  return result;
}
