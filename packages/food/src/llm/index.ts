/**
 * @buttery/food/llm — the LLM half of food classification: the prompt the
 * model is given, the closed slug sets it may answer with, and the zod schema
 * that refuses anything else.
 *
 *   prompt.ts    the PostHog prompt's name, the fallback/reviewable text,
 *                and the variables it takes
 *   schema.ts    the closed slug sets, `llmOutputSchema`,
 *                `LLM_ENRICHMENT_VERSION`, and the `llm:` method string
 *   messages.ts  pure: the `{{recipe_json}}` payload and `compilePrompt`
 *
 * ── Why this is a subpath and not part of the barrel ───────────────────────
 * `../index.ts` deliberately does not re-export this folder. `schema.ts` needs
 * `zod` — the only dependency in `@buttery/food` beyond `parse-ingredient` —
 * and `zod` is declared here as an OPTIONAL peer, so a consumer that never
 * imports `@buttery/food/llm` (every client bundle) never has to have it.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * Anything with I/O or an AI SDK in it stays in `services/pipeline`: fetching
 * the PostHog prompt that replaces `FALLBACK_PROMPT`, the `generateText` call,
 * the rules-vs-LLM merge (which shapes `recipe_enrichment_label` rows and owns
 * the disagreement-capture concern), and the reads and writes themselves.
 */

export * from "./prompt.ts";
export * from "./schema.ts";
export * from "./messages.ts";
