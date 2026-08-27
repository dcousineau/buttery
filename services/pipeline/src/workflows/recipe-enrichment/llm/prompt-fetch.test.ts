import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptResult } from "@posthog/ai";
import { fetchPrompt, PROMPT_CACHE_TTL_SECONDS, type PromptsClient, resetPromptCache } from "#/workflows/recipe-enrichment/llm/prompt-fetch.ts";
import { FALLBACK_PROMPT, PROMPT_NAME } from "#/workflows/recipe-enrichment/llm/prompt.ts";

/**
 * `prompt-fetch.ts` against a fake `Prompts` client (plan §12.1).
 *
 * Since this module moved onto `@posthog/ai`'s official client, most of what
 * this suite used to assert belongs to the vendor now and is gone with the code
 * that justified it: the URL, the response-shape guessing, the hand-rolled TTL
 * cache. Caching in particular is deliberately NOT re-tested here — it is the
 * SDK's `cacheTtlSeconds`, and a test that asserted it would be testing
 * PostHog's implementation through a fake that does not have one.
 *
 * What is left is exactly this module's own contract, which is the part that
 * would silently break the pipeline if it were wrong:
 *
 *   - every failure mode degrades to the COMMITTED fallback, never throws
 *   - `version: null` marks a run that did not use a PostHog prompt (the thing
 *     `llm_prompt_version` is queried for)
 *   - the timeout the SDK does not have is enforced here
 *
 * No live PostHog call is possible here (L11): the tested path is handed a
 * fake client, or `null`, and never constructs a real one.
 */

beforeEach(() => {
  resetPromptCache();
  vi.restoreAllMocks();
});

/** A `PromptRemoteResult` as the SDK returns one on a successful fetch. */
function remoteResult(overrides: Partial<PromptResult> = {}): PromptResult {
  return {
    source: "api",
    prompt: "You are a classifier. {{recipe_json}}",
    name: PROMPT_NAME,
    version: 7,
    label: "production",
    config: null,
    ...overrides,
  } as PromptResult;
}

/** The SDK's own fallback result — what `get()` returns when its `fallback` option absorbs an API failure. */
function codeFallbackResult(): PromptResult {
  return { source: "code_fallback", prompt: FALLBACK_PROMPT, name: undefined, version: undefined, label: undefined, config: undefined };
}

function clientReturning(result: PromptResult | Promise<PromptResult>): { client: PromptsClient; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn().mockReturnValue(Promise.resolve(result));
  return { client: { get }, get };
}

describe("fetchPrompt — the happy path", () => {
  it("returns the fetched text, name and version, and asks for the production label", async () => {
    const { client, get } = clientReturning(remoteResult());
    const result = await fetchPrompt({ client, env: {} });

    expect(result).toEqual({ text: "You are a classifier. {{recipe_json}}", name: PROMPT_NAME, version: 7, source: "api" });
    expect(get).toHaveBeenCalledWith(PROMPT_NAME, {
      label: "production",
      cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
      // The SDK's own fallback is what turns an API failure into an ordinary
      // result rather than a throw — passing it is not optional.
      fallback: FALLBACK_PROMPT,
    });
  });

  it("passes `stale_cache` through, because serving the last good prompt is not the same as giving up", async () => {
    // This case did not exist before the SDK: the hand-rolled version dropped
    // straight to the committed fallback whenever the API failed. A stale
    // PostHog prompt is strictly closer to what the operator asked for.
    const { client } = clientReturning(remoteResult({ source: "stale_cache", version: 6 }));
    const result = await fetchPrompt({ client, env: {} });
    expect(result.source).toBe("stale_cache");
    expect(result.version).toBe(6);
  });
});

describe("fetchPrompt — every failure degrades to the committed prompt", () => {
  it("returns the fallback with version null when the SDK reports its own code_fallback", async () => {
    const { client } = clientReturning(codeFallbackResult());
    const result = await fetchPrompt({ client, env: {} });

    expect(result.text).toBe(FALLBACK_PROMPT);
    // The queryable record that this recipe did not run on a PostHog prompt.
    expect(result.version).toBeNull();
    expect(result.name).toBe(PROMPT_NAME);
    expect(result.source).toBe("code_fallback");
  });

  it("returns the fallback when no client could be built (nothing configured)", async () => {
    // The common case: every dev machine, and any deploy where the personal
    // key has not been set yet.
    const result = await fetchPrompt({ client: null, env: {} });
    expect(result).toEqual({ text: FALLBACK_PROMPT, name: PROMPT_NAME, version: null, source: "code_fallback" });
  });

  it("returns the fallback, and does not throw, when the client itself throws", async () => {
    const client = { get: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as PromptsClient;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchPrompt({ client, env: {} });
    expect(result.text).toBe(FALLBACK_PROMPT);
    expect(result.version).toBeNull();
  });

  it("gives up after the fetch budget and uses the fallback, rather than stalling the job", async () => {
    // The one guarantee the SDK does not provide: `Prompts.get` takes no
    // timeout, and `llm-enrich` must not wait on a slow PostHog when it has a
    // perfectly good committed prompt in hand.
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const never = new Promise<PromptResult>(() => {});
      const client = { get: vi.fn().mockReturnValue(never) } as unknown as PromptsClient;

      const pending = fetchPrompt({ client, env: {} });
      await vi.advanceTimersByTimeAsync(2000);

      expect(await pending).toEqual({ text: FALLBACK_PROMPT, name: PROMPT_NAME, version: null, source: "code_fallback" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves normally when the fetch finishes inside the budget", async () => {
    vi.useFakeTimers();
    try {
      let resolveGet: (value: PromptResult) => void = () => {};
      const client = { get: vi.fn().mockReturnValue(new Promise<PromptResult>((r) => (resolveGet = r))) } as unknown as PromptsClient;

      const pending = fetchPrompt({ client, env: {} });
      await vi.advanceTimersByTimeAsync(1500);
      resolveGet(remoteResult());

      expect((await pending).version).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
