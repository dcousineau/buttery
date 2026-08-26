import { generateObject, NoObjectGeneratedError } from "ai";
import type { CallWarning, FinishReason, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { llmOutputSchema, type LlmOutput } from "#/workflows/recipe-enrichment/llm/schema.ts";
import type { ClassifierLine, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * Orchestration for the LLM second opinion (llm plan §4): build messages
 * (pure) → `generateObject` → validate → hand back a validated {@link LlmOutput}
 * plus everything `capture.ts` needs to describe the call. No DB, no queue,
 * no `posthog-node` import — `steps.ts` (another module, built in parallel) is
 * the only caller that touches any of those, and it is also the only thing
 * that may import `merge.ts`: turning a validated {@link LlmOutput} into
 * candidate `Label`s is `merge.ts`'s job, not this file's (plan §8). This file
 * stops at the validated model output, on purpose, for the same reason the
 * rules `classify.ts` stops at `Label[]` and never touches the database —
 * pure/near-pure orchestration is what makes this file testable against a
 * mock model (`classify.test.ts`) with zero fixtures beyond hand-built
 * `ClassifierLine[]`.
 *
 * The two builders below (`buildRecipeJson`, `buildMessages`) are exported and
 * fully pure — they run over plain data and touch neither a model nor the
 * network — so a test can assert on the exact payload a prompt change would
 * see without spinning up a mock model at all.
 */

// --- buildRecipeJson (plan §6.3) -------------------------------------------

/** One ingredient line as the model sees it: just enough to read, and the same ordinal every evidence trail (rules or LLM) cites. */
export interface RecipeJsonLine {
  ordinal: number;
  text: string;
}

/** One rules verdict as the model sees it — the context plan §6.3 says is included deliberately. */
export interface RecipeJsonRulesLabel {
  dimension: string;
  slug: string;
  verdict: string;
  confidence: number;
}

export interface BuildRecipeJsonInput {
  recipeName: string;
  lines: readonly ClassifierLine[];
  /** The rules classifier's own labels for this recipe — `classify()`'s output, or `[]` for a recipe with none. */
  rulesLabels: readonly Label[];
}

/**
 * The `{{recipe_json}}` payload (plan §6.3, §7.1): the recipe name, every
 * ingredient line with its `ordinal` (the same ordinal the rules' own
 * `EvidenceLine`s and the LLM's own `ordinals` arrays cite — one numbering
 * scheme, read by both providers and by the human comparing them in the dev
 * panel), and the rules classifier's own labels.
 *
 * The rules labels are trimmed to `{dimension, slug, verdict, confidence}` —
 * no `method` (the model has no use for a string it cannot act on) and no
 * `evidence` (that is the rules' *reasoning*, in the rules' own vocabulary of
 * ingredient traits and text patterns the model was never taught; handing it
 * over would be asking the model to explain someone else's homework instead
 * of doing its own read of the lines). Included deliberately anyway (plan
 * §6.3): the model should explain disagreement with a rules verdict, not
 * rediscover everything cold, and the judge evals (plan §5.4) grade exactly
 * that explanation quality.
 *
 * Only `ordinal` and `text` travel for each line — not `foodSlug`, `traits`,
 * or `via`. Those are the rules classifier's own internal signals (lexicon
 * hits, trait lookups); handing them to the model would be pre-digesting the
 * ingredient the same way a rule already did, when the entire point of a
 * second opinion is an independent read of the free text.
 *
 * Compact `JSON.stringify` (no pretty-printing): this string is spent tokens
 * on every `llm-enrich` job, and whitespace the model does not need to parse
 * JSON is pure waste at corpus volume.
 */
export function buildRecipeJson(input: BuildRecipeJsonInput): string {
  const payload = {
    name: input.recipeName,
    ingredients: input.lines.map((line): RecipeJsonLine => ({ ordinal: line.ordinal, text: line.text })),
    rulesLabels: input.rulesLabels.map((label): RecipeJsonRulesLabel => ({ dimension: label.dimension, slug: label.slug, verdict: label.verdict, confidence: label.confidence })),
  };
  return JSON.stringify(payload);
}

// --- buildMessages (plan §6.2, §6.3) ---------------------------------------

/** The template variable `prompt.ts`/`prompt-fetch.ts` use — kept here too so a caller can spot a stale prompt without importing `prompt.ts`. */
export const RECIPE_JSON_VARIABLE = "{{recipe_json}}";

/**
 * The fixed trailing turn every call sends, never templated and never
 * user-configurable. See {@link buildMessages}'s doc comment for why it
 * exists at all.
 */
const CLASSIFY_TRIGGER_MESSAGE = "Classify the recipe described above and return only the JSON object the system instructions specify.";

/**
 * Compile `{{recipe_json}}` into `promptText` and shape the result into the
 * message array `generateObject` takes (plan §6.2's REST fallback path: the
 * PostHog Prompts SDK would compile this server-side, but `prompt-fetch.ts`
 * only ever hands this file plain `{text, version}` — the substitution has to
 * happen somewhere, and it happens here, once, next to the schema it feeds).
 *
 * The prompt is documented (plan §6.3) as "one system prompt, one
 * `{{recipe_json}}` variable" — but the AI SDK's own prompt validation
 * (`standardizePrompt`, `node_modules/ai/dist/index.js`) refuses a `system`
 * role message inside `messages` unless the caller explicitly opts in with
 * `allowSystemInMessages: true` (`classifyWithLlm` below does), AND refuses
 * an empty `messages` array outright ("messages must not be empty") — a
 * request cannot be *only* a system message. So the array below is two
 * messages, not one: the compiled system prompt (name, task, both closed
 * enums, the caution list, and the substituted recipe JSON — everything the
 * plan calls "the prompt"), followed by a fixed, minimal user turn that only
 * exists to satisfy that structural requirement. `CLASSIFY_TRIGGER_MESSAGE`
 * carries no recipe content and is never templated — every token that
 * describes *this* recipe lives in the system message, exactly as §6.3
 * describes the prompt.
 *
 * Throws if `promptText` has no `{{recipe_json}}` occurrence at all: a prompt
 * missing the variable would silently ship with no ingredient list in it,
 * which is a broken prompt (in PostHog or in `prompt.ts`'s fallback) that
 * must fail loudly at the one point that would otherwise swallow it, not send
 * Kimi a recipe-shaped question with no recipe.
 */
export function buildMessages(args: { promptText: string; recipeJson: string }): ModelMessage[] {
  if (!args.promptText.includes(RECIPE_JSON_VARIABLE)) {
    throw new Error(`prompt text has no ${RECIPE_JSON_VARIABLE} occurrence — the model would receive no recipe data`);
  }
  const compiled = args.promptText.replaceAll(RECIPE_JSON_VARIABLE, args.recipeJson);
  return [
    { role: "system", content: compiled },
    { role: "user", content: CLASSIFY_TRIGGER_MESSAGE },
  ];
}

// --- classifyWithLlm (plan §7.1, §9.2 step 5) -------------------------------

/**
 * `AbortSignal.timeout(60_000)` is a job-level policy decision (plan §9.2
 * step 5 names the exact figure), so `steps.ts` is expected to pass its own —
 * this default only covers direct callers (tests, a REPL) that don't.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Sized for the schema's dense worst case, not the sparse common case (plan
 * §7.1 — the model emits only non-default judgments, so most calls use a
 * fraction of this). Counting every closed enum this schema allows at once:
 * 10 allergens + 13 diet slugs (7 rules-emitted + 6 macro/paleo, `LLM_DIET_SLUGS`)
 * + 2 cuisines + 2 meal types + 1 spice level = 28 entries. Each entry is at
 * most a slug, a verdict, a confidence, a handful of `ordinals`, and an
 * optional ≤500-char `note` — call it ~120 tokens of JSON per entry at the
 * high end (the note dominates). 28 × 120 ≈ 3,400 tokens; 4,096 rounds that up
 * with headroom for JSON punctuation/whitespace and leaves Kimi room to finish
 * a well-formed object instead of truncating mid-string on the rare
 * everything-flagged recipe, without being so generous that a runaway
 * completion goes uncapped.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Thrown when `generateObject` could not produce output matching
 * {@link llmOutputSchema} — Kimi returning prose-wrapped JSON, a truncated
 * object, or a value outside a closed enum are all the same failure shape
 * from here: the schema validated nothing, and there is a raw response worth
 * keeping. Plan §7.1: this becomes `llm_status='error'` and an `$ai_is_error`
 * capture carrying `rawText` as `$ai_error`, and is retried per the job's own
 * `attempts`/backoff (plan §9.2) — an occasional invalid-JSON response is an
 * expected Kimi failure mode, not a bug in this file, and retry-then-error is
 * the honest way to handle it.
 *
 * Deliberately NOT thrown for an aborted/timed-out call — that rejects with
 * whatever the AI SDK / abort machinery threw (typically a `DOMException`
 * named `"AbortError"`), unwrapped, because there is no raw model text to
 * attach and `steps.ts` needs to tell "the model never answered" apart from
 * "the model answered wrong" to log/capture them differently.
 */
export class LlmClassifyError extends Error {
  /**
   * The model's raw text, when the underlying failure had one (a schema/parse
   * rejection). `undefined` for a failure with no response text to show —
   * e.g. every field was schema-invalid and the SDK couldn't recover text
   * either.
   */
  readonly rawText: string | undefined;

  constructor(message: string, options: { cause: unknown; rawText: string | undefined }) {
    super(message, { cause: options.cause });
    this.name = "LlmClassifyError";
    this.rawText = options.rawText;
  }
}

/** One message in the `$ai_output_choices` shape `capture.ts` forwards to PostHog (posthog-node's AI-observability convention: an array of `{role, content}`). */
export interface LlmOutputChoice {
  role: string;
  content: string;
}

export interface ClassifyWithLlmArgs {
  /** From `provider.ts`'s `resolveProvider().model` — this file never resolves a provider itself (plan §6.1: "nothing else in the folder may know which provider runs"). */
  model: LanguageModel;
  /** The compiled-or-fallback prompt text from `prompt-fetch.ts`'s `{text, version}` — this file only reads `.text`; the caller decides what to do with `.version`. */
  promptText: string;
  recipeName: string;
  lines: readonly ClassifierLine[];
  /** The rules classifier's labels for this recipe (plan §6.3's "context, deliberately"). */
  rulesLabels: readonly Label[];
  /** Overrides {@link DEFAULT_MAX_OUTPUT_TOKENS}. Exposed for a future prompt/schema change to tune without touching this file, not expected to vary per call in practice. */
  maxOutputTokens?: number;
  /** Overrides the `AbortSignal.timeout(60_000)` default (plan §9.2 step 5) — `steps.ts` passes its own so one slow call can't outlive the job's own budget. */
  abortSignal?: AbortSignal;
}

/**
 * Everything `capture.ts` needs to build a `$ai_generation` event (plan
 * §10), plus the validated output `merge.ts` needs. Carries no DB/queue
 * concerns — see this file's module doc.
 */
export interface LlmClassifyResult {
  /** The validated model output — what `merge.ts` turns into candidate `Label`s. */
  output: LlmOutput;
  /** Exactly the messages sent, for `$ai_input` (redacted by `capture.ts` per origin, plan L10 — this file does no redaction itself). */
  messages: ModelMessage[];
  /** `result.usage` from the AI SDK, for `$ai_input_tokens`/`$ai_output_tokens`. */
  usage: LanguageModelUsage;
  /** Wall-clock time of the `generateObject` call in milliseconds, for `$ai_latency` (`capture.ts` converts to seconds — plan §10 names the unit PostHog expects). */
  latencyMs: number;
  /** `result.finishReason` — surfaced so `capture.ts` can decide whether a `"length"` finish is worth its own signal (an output that hit `maxOutputTokens`). */
  finishReason: FinishReason;
  /** `result.response.id`, when the provider returned one — `undefined` is a normal outcome, not a missing-data bug. */
  responseId: string | undefined;
  /**
   * Best-effort HTTP status. `ai@7`'s `GenerateObjectResult` does not surface
   * a numeric status on a successful call — only `response.headers`/`.body`,
   * neither of which parses to a status code, per
   * `node_modules/ai/dist/index.d.ts`'s `LanguageModelResponseMetadata`. This
   * field is always `undefined` from a successful `classifyWithLlm` call
   * today; it exists so `LlmClassifyResult`'s shape does not have to change
   * if a later provider/SDK version does expose one, and so `capture.ts` has
   * one stable field to read for `$ai_http_status` regardless.
   */
  httpStatus: number | undefined;
  /** Provider warnings (e.g. an unsupported setting silently dropped) — worth a look during rollout, not fatal. */
  warnings: CallWarning[] | undefined;
  /** The `$ai_output_choices` shape (plan §10) — see the field's own doc on {@link LlmOutputChoice} for why this is `[{role, content}]` and not the raw provider text. */
  outputChoices: LlmOutputChoice[];
}

/**
 * Build messages, call `generateObject` against {@link llmOutputSchema}, and
 * return the validated output plus the capture-ready call metadata (plan §4,
 * §7.1, §9.2 step 5).
 *
 * No `mode: 'json'` fallback (plan §7.1 raised the possibility "on provider
 * JSON-mode quirks", contingent on what `ai@7` actually supports): the
 * installed `generateObject` signature
 * (`node_modules/ai/dist/index.d.ts`) has no `mode` option at all — the
 * `output` discriminant (`'object' | 'array' | 'enum' | 'no-schema'`) is the
 * only generation-strategy switch left, and this call already uses its
 * default (`'object'`), which is the schema-constrained mode `mode: 'json'`
 * used to name in the AI SDK's v4-era API. There is nothing to fall back to
 * and nothing this file can decide "by what the mock tests can express" that
 * the type signature does not already decide for it — if a live provider
 * quirk turns out to need one, that is a schema/prompt change (`schemaName`/
 * `schemaDescription`, both still present on `generateObject`'s options), not
 * a `mode` this SDK major exposes.
 *
 * `generateObject` is `@deprecated` in the installed `ai@7.0.79` (the
 * doc comment on it says "Use `generateText` with an `output` setting
 * instead") — noted here rather than silently worked around, because the
 * plan (L5) is explicit that this codebase uses `generateObject`, and
 * switching orchestration functions is a bigger, deliberate call than one
 * slice of one plan should make unilaterally. It still exists, is fully
 * typed, and behaves as documented against the mock model in
 * `classify.test.ts`; a migration to `generateText({ output })` is a future
 * decision for whoever owns this file next, once the deprecation has a
 * removal date attached to it.
 */
export async function classifyWithLlm(args: ClassifyWithLlmArgs): Promise<LlmClassifyResult> {
  const recipeJson = buildRecipeJson({ recipeName: args.recipeName, lines: args.lines, rulesLabels: args.rulesLabels });
  const messages = buildMessages({ promptText: args.promptText, recipeJson });
  const abortSignal = args.abortSignal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const maxOutputTokens = args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const startedAt = performance.now();
  try {
    const result = await generateObject({
      model: args.model,
      schema: llmOutputSchema,
      messages,
      // See buildMessages' doc comment: the compiled prompt is a system-role
      // message inside `messages`, which the AI SDK refuses by default.
      allowSystemInMessages: true,
      maxOutputTokens,
      abortSignal,
    });
    const latencyMs = performance.now() - startedAt;
    return {
      output: result.object,
      messages,
      usage: result.usage,
      latencyMs,
      finishReason: result.finishReason,
      responseId: result.response?.id,
      httpStatus: undefined,
      warnings: result.warnings,
      outputChoices: [{ role: "assistant", content: JSON.stringify(result.object) }],
    };
  } catch (err) {
    // `NoObjectGeneratedError` is the AI SDK's name for "the response never
    // validated against the schema" — invalid JSON, prose wrapping it,
    // truncation, an out-of-enum value, anything zod rejected. It is the one
    // failure shape with a raw `.text` worth keeping (see LlmClassifyError's
    // doc). Everything else (an aborted/timed-out call, a network/provider
    // error) is rethrown as the AI SDK raised it — there is no model text to
    // attach, and collapsing it into LlmClassifyError would hide from
    // `steps.ts` that the model never got a chance to answer at all.
    if (NoObjectGeneratedError.isInstance(err)) {
      throw new LlmClassifyError(`llm output failed schema validation: ${err.message}`, { cause: err, rawText: err.text });
    }
    throw err;
  }
}
