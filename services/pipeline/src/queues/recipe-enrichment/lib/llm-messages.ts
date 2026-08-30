import { NoObjectGeneratedError } from "ai";
import type { ModelMessage } from "ai";
import { CLASSIFY_TRIGGER_MESSAGE, compilePrompt, type CompilePromptInput } from "@buttery/food/llm";

/**
 * What is left of this module after the food-classification move: the two
 * pieces that know about the AI SDK, and nothing else.
 *
 * The prompt itself, the closed slug sets, the zod output schema and the pure
 * `{{recipe_json}}`/`compilePrompt` builders all live in `@buttery/food/llm`
 * now, beside the rules classifier they give a second opinion on. What could
 * not follow them is exactly what imports `ai`: {@link buildMessages}, which
 * wraps `compilePrompt`'s text into the `ModelMessage[]` `generateText` takes,
 * and {@link modelRawText}, which reads an `ai` error. `@buttery/food` has no
 * AI SDK dependency and should not grow one.
 *
 * Still no model call and no I/O here — that lives in `index.ts`'s
 * `llm-enrich` step, next to the `generateText` call itself.
 */

/** Re-exported so this folder's callers keep one import for "everything about building the request". */
export { buildRecipeJson, RECIPE_JSON_VARIABLE } from "@buttery/food/llm";

/**
 * Compile a prompt's `{{...}}` variables and shape the result into the message
 * array `generateText` takes. See `@buttery/food/llm`'s `compilePrompt` for the
 * substitution rules (and for why `{{recipe_json}}` is the one variable whose
 * absence throws).
 *
 * Two messages, not one: the AI SDK refuses a `system`-role message inside
 * `messages` unless the caller passes `allowSystemInMessages: true`, and
 * refuses an empty `messages` array outright — a request cannot be *only* a
 * system message. So this returns the compiled system prompt followed by a
 * fixed, minimal user turn that exists only to satisfy that requirement;
 * `CLASSIFY_TRIGGER_MESSAGE` carries no recipe content of its own.
 */
export function buildMessages(args: CompilePromptInput): ModelMessage[] {
  return [
    { role: "system", content: compilePrompt(args) },
    { role: "user", content: CLASSIFY_TRIGGER_MESSAGE },
  ];
}

/** The model's raw text when `err` is a schema-validation rejection — `undefined` for any other failure (abort, network). */
export function modelRawText(err: unknown): string | undefined {
  return NoObjectGeneratedError.isInstance(err) ? err.text : undefined;
}
