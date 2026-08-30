import { NoObjectGeneratedError } from "ai";
import type { ModelMessage } from "ai";
import type { ClassifierLine, Label } from "#/queues/recipe-enrichment/types.ts";

/**
 * The pure half of talking to the model: building the `{{recipe_json}}`
 * payload and the message array `generateText` takes. No model call, no I/O —
 * that lives in `index.ts`'s `llm-enrich` step, next to the `generateText`
 * call itself.
 */

/** One ingredient line as the model sees it — same `ordinal` every evidence trail (rules or LLM) cites. */
export interface RecipeJsonLine {
  ordinal: number;
  text: string;
}

/** One rules verdict as the model sees it. */
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
 * The `{{recipe_json}}` payload: recipe name, every ingredient line with its
 * `ordinal`, and the rules classifier's own labels trimmed to
 * `{dimension, slug, verdict, confidence}` — no `method`, no `evidence` (that
 * is the rules' own reasoning, in a vocabulary the model was never taught).
 * Included so the model can explain disagreement with a rules verdict rather
 * than rediscover everything cold.
 *
 * Only `ordinal`/`text` travel per line — not `foodSlug`/`traits`/`via`, which
 * are the rules classifier's internal signals; handing them over would
 * pre-digest the ingredient the way a rule already did, defeating the point
 * of an independent read.
 *
 * Compact `JSON.stringify` — this string is spent tokens on every job.
 */
export function buildRecipeJson(input: BuildRecipeJsonInput): string {
  const payload = {
    name: input.recipeName,
    ingredients: input.lines.map((line): RecipeJsonLine => ({ ordinal: line.ordinal, text: line.text })),
    rulesLabels: input.rulesLabels.map((label): RecipeJsonRulesLabel => ({ dimension: label.dimension, slug: label.slug, verdict: label.verdict, confidence: label.confidence })),
  };
  return JSON.stringify(payload);
}

/** The one template variable a prompt MUST carry — see {@link buildMessages}. */
export const RECIPE_JSON_VARIABLE = "{{recipe_json}}";

/** `foo` → `{{foo}}`, PostHog Prompt Management's interpolation syntax. */
function variableToken(name: string): string {
  return `{{${name}}}`;
}

/** The fixed trailing turn every call sends — never templated, never user-configurable. */
const CLASSIFY_TRIGGER_MESSAGE = "Classify the recipe described above and return only the JSON object the system instructions specify.";

/**
 * Compile a prompt's `{{...}}` variables into `promptText` and shape the
 * result into the message array `generateText` takes.
 *
 * Two messages, not one: the AI SDK refuses a `system`-role message inside
 * `messages` unless the caller passes `allowSystemInMessages: true`, and
 * refuses an empty `messages` array outright — a request cannot be *only* a
 * system message. So this returns the compiled system prompt followed by a
 * fixed, minimal user turn that exists only to satisfy that requirement;
 * `CLASSIFY_TRIGGER_MESSAGE` carries no recipe content of its own.
 *
 * ── `recipeJson` is required; `variables` are not ─────────────────────────
 * Throws if `promptText` has no `{{recipe_json}}` occurrence — a prompt
 * missing THAT variable would silently ship with no ingredient list in it,
 * which is a broken job, not a degraded one. Every other variable is
 * best-effort by design: `promptText` usually comes from PostHog, where a
 * published version predating a new variable is a normal state (it simply
 * carries the list inline instead), and a version that never learned the
 * variable must keep classifying rather than fail the queue. An unrecognized
 * `{{...}}` left in the text is likewise passed through untouched.
 *
 * ── Substitution order is load-bearing ────────────────────────────────────
 * `variables` are substituted first and `recipeJson` LAST, so nothing inside
 * the recipe payload can be re-read as a variable token. Recipe names and
 * ingredient lines are user-supplied; a recipe called `{{diet_slugs}}` must
 * end up as those literal characters in the prompt, not as the diet list.
 */
export function buildMessages(args: { promptText: string; recipeJson: string; variables?: Readonly<Record<string, string>> }): ModelMessage[] {
  if (!args.promptText.includes(RECIPE_JSON_VARIABLE)) {
    throw new Error(`prompt text has no ${RECIPE_JSON_VARIABLE} occurrence — the model would receive no recipe data`);
  }
  let compiled = args.promptText;
  for (const [name, value] of Object.entries(args.variables ?? {})) {
    compiled = compiled.replaceAll(variableToken(name), value);
  }
  compiled = compiled.replaceAll(RECIPE_JSON_VARIABLE, args.recipeJson);
  return [
    { role: "system", content: compiled },
    { role: "user", content: CLASSIFY_TRIGGER_MESSAGE },
  ];
}

/** The model's raw text when `err` is a schema-validation rejection — `undefined` for any other failure (abort, network). */
export function modelRawText(err: unknown): string | undefined {
  return NoObjectGeneratedError.isInstance(err) ? err.text : undefined;
}
