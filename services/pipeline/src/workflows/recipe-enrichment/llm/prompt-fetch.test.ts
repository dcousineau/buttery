import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPrompt, PROMPT_CACHE_TTL_MS, resetPromptCache } from "#/workflows/recipe-enrichment/llm/prompt-fetch.ts";
import { FALLBACK_PROMPT } from "#/workflows/recipe-enrichment/llm/prompt.ts";

/**
 * Pure-injection suite (plan §12.1, L11): every case here goes through
 * `fetchPrompt`'s `{ fetchImpl, now, env }` deps, never the real `fetch` or
 * the real clock. No test in this file makes a network call — the fallback
 * path (no key configured) is exercised first, deliberately, because L11
 * calls that "the tested-by-default path": it's what every environment
 * without PostHog access — including this one — actually runs.
 */

const CONFIGURED_ENV = { POSTHOG_PERSONAL_API_KEY: "phx_test_personal_key", POSTHOG_PROJECT_ID: "538428" };

/** A minimal stand-in for the `Response` shape `resolvePrompt` reads: `ok`, `status`, and an async `json()`. */
function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => {
  resetPromptCache();
  vi.restoreAllMocks();
});

describe("fetchPrompt — fallback on failure (version: null in every case)", () => {
  it("falls back without attempting a fetch when POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID are absent", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPrompt({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: FALLBACK_PROMPT, version: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back when only the project id is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPrompt({ env: { POSTHOG_PERSONAL_API_KEY: "phx_test" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.version).toBeNull();
    expect(result.text).toBe(FALLBACK_PROMPT);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back on a non-200 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(500, { error: "internal" }));
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: FALLBACK_PROMPT, version: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back when the fetch throws — the timeout / network-error shape", async () => {
    // `AbortSignal.timeout(2000)` firing surfaces as `fetchImpl` rejecting
    // with an abort-flavored error; a plain network failure looks the same
    // to `resolvePrompt`, so one case covers both.
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException("The operation was aborted.", "TimeoutError"));
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: FALLBACK_PROMPT, version: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back on a 200 response whose body has no recognizable prompt text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { unexpected_field: true }));
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: FALLBACK_PROMPT, version: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back when the body's json() itself rejects (malformed JSON)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token in JSON")),
    });
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: FALLBACK_PROMPT, version: null });
  });
});

describe("fetchPrompt — happy path", () => {
  it("returns the fetched text and version, and hits the documented endpoint shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { prompt: "Custom PostHog prompt text {{recipe_json}}", version: 7 }));
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ text: "Custom PostHog prompt text {{recipe_json}}", version: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.posthog.com/api/projects/538428/llm_prompts/resolve/name/recipe-llm-enrichment/?label=production");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phx_test_personal_key");
  });

  it("also accepts a chat-shaped `content` array (documented UNVERIFIED-AGAINST-LIVE-POSTHOG fallback)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse(200, {
        content: [
          { role: "system", content: "System turn one." },
          { role: "system", content: "System turn two." },
        ],
        version: 3,
      }),
    );
    const result = await fetchPrompt({ env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ text: "System turn one.\n\nSystem turn two.", version: 3 });
  });
});

describe("fetchPrompt — cache TTL", () => {
  it("does not re-fetch inside the TTL, and re-fetches once the TTL has elapsed", async () => {
    let currentTimeMs = 0;
    const now = () => currentTimeMs;
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { prompt: "cached prompt", version: 2 }));
    const deps = { env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now };

    const first = await fetchPrompt(deps);
    expect(first).toEqual({ text: "cached prompt", version: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Well inside the TTL — same cached result, no second network attempt.
    currentTimeMs += PROMPT_CACHE_TTL_MS - 1;
    const second = await fetchPrompt(deps);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past the TTL — the cache has expired, so this call re-fetches.
    currentTimeMs += 2;
    const third = await fetchPrompt(deps);
    expect(third).toEqual({ text: "cached prompt", version: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches a fallback result too, so a persistently-unreachable PostHog isn't retried every call within the TTL", async () => {
    let currentTimeMs = 0;
    const now = () => currentTimeMs;
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(500, {}));
    const deps = { env: CONFIGURED_ENV, fetchImpl: fetchImpl as unknown as typeof fetch, now };

    await fetchPrompt(deps);
    await fetchPrompt(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentTimeMs += PROMPT_CACHE_TTL_MS;
    await fetchPrompt(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
