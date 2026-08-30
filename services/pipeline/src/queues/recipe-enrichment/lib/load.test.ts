import { describe, expect, it } from "vitest";
import { contentChanged, isLlmFresh, isRulesFresh, rulesPassCurrent, type LlmEnrichmentState, type LlmRunIdentity } from "#/queues/recipe-enrichment/lib/load.ts";

/**
 * The freshness predicates, which are pure — the rest of `load.ts` is covered
 * by `load.db.test.ts` against a real database. These decide whether a job
 * spends a model call, so every arm is worth an example.
 */

const HASH = "content-fingerprint";
const CLASSIFIER_VERSION = 2;
const LLM_VERSION = 1;
const RUN: LlmRunIdentity = { model: "moonshot:kimi-k2-0905-preview", promptVersion: 3 };

/** A recipe whose rules pass and LLM pass are both current, under {@link RUN}. */
function freshState(overrides: Partial<LlmEnrichmentState> = {}): LlmEnrichmentState {
  return {
    status: "ok",
    inputHash: HASH,
    classifierVersion: CLASSIFIER_VERSION,
    llmStatus: "ok",
    llmVersion: LLM_VERSION,
    llmInputHash: HASH,
    llmModel: RUN.model,
    llmPromptVersion: RUN.promptVersion,
    ...overrides,
  };
}

describe("isRulesFresh", () => {
  it("is false for a recipe that has never been classified", () => {
    expect(isRulesFresh(null, HASH, CLASSIFIER_VERSION, false)).toBe(false);
  });

  it("is true only when status, version and hash all match, and force is off", () => {
    const state = freshState();
    expect(isRulesFresh(state, HASH, CLASSIFIER_VERSION, false)).toBe(true);
    expect(isRulesFresh(state, HASH, CLASSIFIER_VERSION, true)).toBe(false);
    expect(isRulesFresh(state, "different-content", CLASSIFIER_VERSION, false)).toBe(false);
    expect(isRulesFresh(state, HASH, CLASSIFIER_VERSION + 1, false)).toBe(false);
    expect(isRulesFresh(freshState({ status: "error" }), HASH, CLASSIFIER_VERSION, false)).toBe(false);
  });
});

describe("contentChanged", () => {
  it("distinguishes a real content change from a first classification", () => {
    expect(contentChanged(freshState({ inputHash: "older" }), HASH)).toBe(true);
    expect(contentChanged(freshState(), HASH)).toBe(false);
    expect(contentChanged(freshState({ inputHash: null }), HASH)).toBe(false);
    expect(contentChanged(null, HASH)).toBe(false);
  });
});

describe("rulesPassCurrent", () => {
  it("gates llm-enrich on the rules pass it is about to re-derive", () => {
    expect(rulesPassCurrent(freshState(), HASH, CLASSIFIER_VERSION)).toBe(true);
    expect(rulesPassCurrent(null, HASH, CLASSIFIER_VERSION)).toBe(false);
    expect(rulesPassCurrent(freshState({ status: "stale" }), HASH, CLASSIFIER_VERSION)).toBe(false);
    expect(rulesPassCurrent(freshState(), HASH, CLASSIFIER_VERSION + 1)).toBe(false);
    expect(rulesPassCurrent(freshState(), "different-content", CLASSIFIER_VERSION)).toBe(false);
  });
});

describe("isLlmFresh — the question", () => {
  it("short-circuits a recipe already covered at this version, content, model and prompt", () => {
    expect(isLlmFresh(freshState(), HASH, LLM_VERSION, RUN, false)).toBe(true);
  });

  it("re-runs on force, a non-ok status, a version bump, or changed content", () => {
    expect(isLlmFresh(freshState(), HASH, LLM_VERSION, RUN, true)).toBe(false);
    expect(isLlmFresh(freshState({ llmStatus: "skipped" }), HASH, LLM_VERSION, RUN, false)).toBe(false);
    expect(isLlmFresh(freshState({ llmStatus: null }), HASH, LLM_VERSION, RUN, false)).toBe(false);
    expect(isLlmFresh(freshState(), HASH, LLM_VERSION + 1, RUN, false)).toBe(false);
    expect(isLlmFresh(freshState(), "different-content", LLM_VERSION, RUN, false)).toBe(false);
  });
});

describe("isLlmFresh — the answerer", () => {
  it("re-runs when a different model would answer", () => {
    expect(isLlmFresh(freshState({ llmModel: "moonshot:kimi-k2-0711-preview" }), HASH, LLM_VERSION, RUN, false)).toBe(false);
    expect(isLlmFresh(freshState({ llmModel: "qwen:qwen3-max" }), HASH, LLM_VERSION, RUN, false)).toBe(false);
  });

  it("re-runs a row with no recorded model — an unknown answerer is not this one", () => {
    expect(isLlmFresh(freshState({ llmModel: null }), HASH, LLM_VERSION, RUN, false)).toBe(false);
  });

  it("re-runs when a newer prompt version has been released", () => {
    expect(isLlmFresh(freshState({ llmPromptVersion: 2 }), HASH, LLM_VERSION, RUN, false)).toBe(false);
  });

  it("re-runs a row the code fallback wrote once a real prompt version is available", () => {
    expect(isLlmFresh(freshState({ llmPromptVersion: null }), HASH, LLM_VERSION, RUN, false)).toBe(false);
  });

  it("does NOT re-run when the current prompt version is unknown — a PostHog outage must not stampede the corpus", () => {
    const fallbackRun: LlmRunIdentity = { model: RUN.model, promptVersion: null };
    expect(isLlmFresh(freshState({ llmPromptVersion: 3 }), HASH, LLM_VERSION, fallbackRun, false)).toBe(true);
    expect(isLlmFresh(freshState({ llmPromptVersion: null }), HASH, LLM_VERSION, fallbackRun, false)).toBe(true);
    // A model change is still a model change, outage or not.
    expect(isLlmFresh(freshState({ llmModel: "qwen:qwen3-max" }), HASH, LLM_VERSION, fallbackRun, false)).toBe(false);
  });
});
