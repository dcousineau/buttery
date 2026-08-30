import type { PromptResult } from "@posthog/ai";
import { describe, expect, it, vi } from "vitest";
import { fetchPrompt, PROMPT_CACHE_TTL_SECONDS, type PromptsClient } from "#/lib/posthog/prompt-fetch.ts";

/**
 * `lib/posthog/prompt-fetch.ts` against a fake `Prompts` client.
 *
 * This suite moved here with the module it covers, from
 * `workflows/recipe-enrichment/lib/prompt-fetch.test.ts`. Two things changed
 * in the move and nothing else did: the prompt name and fallback text are now
 * arguments rather than `@buttery/food/llm` imports — so the
 * fixtures below are local and deliberately generic, since this module has no
 * business knowing about recipes — and the client is passed in positionally
 * rather than inside a `deps` object. The old suite's `resetPromptCache()`
 * `beforeEach` is gone because the module-scope memoization it reset is gone:
 * `plugins/posthog.ts` builds the client once at boot, and the TTL cache lives
 * inside the SDK.
 *
 * What is asserted is unchanged, because the contract is unchanged. Caching is
 * still deliberately NOT tested here — it is the SDK's `cacheTtlSeconds`, and
 * a test asserting it through a fake that has no cache would be testing
 * nothing. What is left is this module's own contract, the part that would
 * silently break the pipeline if it were wrong:
 *
 *   - every failure mode degrades to the caller's fallback, never throws
 *   - `version: null` marks a run that did not use a PostHog prompt (the thing
 *     `llm_prompt_version` is queried for)
 *   - the timeout the SDK does not have is enforced here
 *
 * No live PostHog call is possible here: the tested path is handed a fake
 * client, or `null`, and never constructs a real one.
 */

const NAME = "test-prompt";
const FALLBACK = "committed fallback text";

/** A `PromptRemoteResult` as the SDK returns one on a successful fetch. */
function remoteResult(overrides: Partial<PromptResult> = {}): PromptResult {
  return {
    source: "api",
    prompt: "You are a classifier. {{recipe_json}}",
    name: NAME,
    version: 7,
    label: "production",
    config: null,
    ...overrides,
  } as PromptResult;
}

/** The SDK's own fallback result — what `get()` returns when its `fallback` option absorbs an API failure. */
function codeFallbackResult(): PromptResult {
  return { source: "code_fallback", prompt: FALLBACK, name: undefined, version: undefined, label: undefined, config: undefined };
}

function clientReturning(result: PromptResult | Promise<PromptResult>): { client: PromptsClient; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn().mockReturnValue(Promise.resolve(result));
  return { client: { get }, get };
}

describe("fetchPrompt — the happy path", () => {
  it("returns the fetched text, name and version, and asks for the production label", async () => {
    const { client, get } = clientReturning(remoteResult());
    const result = await fetchPrompt(client, NAME, FALLBACK);

    expect(result).toEqual({ text: "You are a classifier. {{recipe_json}}", name: NAME, version: 7, source: "api" });
    expect(get).toHaveBeenCalledWith(NAME, {
      label: "production",
      cacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
      // The SDK's own fallback is what turns an API failure into an ordinary
      // result rather than a throw — passing it is not optional.
      fallback: FALLBACK,
    });
  });

  it("passes `stale_cache` through, because serving the last good prompt is not the same as giving up", async () => {
    // A stale PostHog prompt is strictly closer to what the operator asked for
    // than the committed fallback, so it must not be flattened into one.
    const { client } = clientReturning(remoteResult({ source: "stale_cache", version: 6 }));
    const result = await fetchPrompt(client, NAME, FALLBACK);

    expect(result.source).toBe("stale_cache");
    expect(result.version).toBe(6);
  });
});

describe("fetchPrompt — every failure degrades to the caller's fallback", () => {
  it("returns the fallback with version null when the SDK reports its own code_fallback", async () => {
    const { client } = clientReturning(codeFallbackResult());
    const result = await fetchPrompt(client, NAME, FALLBACK);

    expect(result.text).toBe(FALLBACK);
    // The queryable record that this run did not use a PostHog prompt. The SDK
    // leaves `name`/`version` undefined here; both are normalized.
    expect(result.version).toBeNull();
    expect(result.name).toBe(NAME);
    expect(result.source).toBe("code_fallback");
  });

  it("returns the fallback when no client could be built (nothing configured)", async () => {
    // The common case: every dev machine, and any deploy where the personal
    // key has not been set yet.
    const result = await fetchPrompt(null, NAME, FALLBACK);

    expect(result).toEqual({ text: FALLBACK, name: NAME, version: null, source: "code_fallback" });
  });

  it("returns the fallback, and does not throw, when the client itself throws", async () => {
    const client = { get: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as PromptsClient;

    const result = await fetchPrompt(client, NAME, FALLBACK);

    expect(result.text).toBe(FALLBACK);
    expect(result.version).toBeNull();
  });

  it("gives up after the fetch budget and uses the fallback, rather than stalling the job", async () => {
    // The one guarantee the SDK does not provide: `Prompts.get` takes no
    // timeout, and a caller must not wait on a slow PostHog when it has a
    // perfectly good committed prompt in hand.
    vi.useFakeTimers();
    try {
      const never = new Promise<PromptResult>(() => {});
      const client = { get: vi.fn().mockReturnValue(never) } as unknown as PromptsClient;

      const pending = fetchPrompt(client, NAME, FALLBACK);
      await vi.advanceTimersByTimeAsync(2000);

      expect(await pending).toEqual({ text: FALLBACK, name: NAME, version: null, source: "code_fallback" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves normally when the fetch finishes inside the budget", async () => {
    vi.useFakeTimers();
    try {
      let resolveGet: (value: PromptResult) => void = () => {};
      const client = { get: vi.fn().mockReturnValue(new Promise<PromptResult>((r) => (resolveGet = r))) } as unknown as PromptsClient;

      const pending = fetchPrompt(client, NAME, FALLBACK);
      await vi.advanceTimersByTimeAsync(1500);
      resolveGet(remoteResult());

      expect((await pending).version).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
});
