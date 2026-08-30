import { NoObjectGeneratedError } from "ai";

/**
 * Copied here for `plugins/ai.ts` (S1) from
 * `workflows/recipe-enrichment/lib/llm-messages.ts`, where the original
 * still lives and still serves `recipe-enrichment/index.ts` unchanged. Pure
 * and generic already — it inspects an AI SDK error shape, not a recipe.
 */

/** The model's raw text when `err` is a schema-validation rejection — `undefined` for any other failure (abort, network). */
export function modelRawText(err: unknown): string | undefined {
  return NoObjectGeneratedError.isInstance(err) ? err.text : undefined;
}
