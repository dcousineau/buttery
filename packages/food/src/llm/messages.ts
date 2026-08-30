import type { ClassifierLine, Label } from "../classifiers/types.ts";

/**
 * @buttery/food/llm/messages — the pure half of talking to the model: building
 * the `{{recipe_json}}` payload and compiling a prompt template's `{{...}}`
 * variables into finished text.
 *
 * Moved here from `services/pipeline/src/queues/recipe-enrichment/lib/llm-messages.ts`
 * along with the prompt and the schema, minus everything that knows about the
 * AI SDK. What stayed behind in the pipeline is exactly the AI-SDK-shaped
 * part: `buildMessages`, which wraps {@link compilePrompt}'s output into the
 * `ModelMessage[]` `generateText` takes, and `modelRawText`, which reads an
 * `ai` error. Nothing here imports `ai`, so a script that only wants to SEE
 * the prompt for a recipe (`services/pipeline/src/cli/enrichment-prompt.ts`)
 * never has to construct a model call to get it.
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

/** The one template variable a prompt MUST carry — see {@link compilePrompt}. */
export const RECIPE_JSON_VARIABLE = "{{recipe_json}}";

/** `foo` → `{{foo}}`, PostHog Prompt Management's interpolation syntax. */
function variableToken(name: string): string {
  return `{{${name}}}`;
}

/**
 * The fixed trailing user turn every call sends — never templated, never
 * user-configurable. Lives here rather than in the pipeline's `buildMessages`
 * because it is prompt content, and a script that renders "what the model
 * actually receives" has to be able to show it.
 */
export const CLASSIFY_TRIGGER_MESSAGE = "Classify the recipe described above and return only the JSON object the system instructions specify.";

export interface CompilePromptInput {
  /** The prompt template — PostHog's text, or `FALLBACK_PROMPT`. */
  promptText: string;
  /** {@link buildRecipeJson}'s output. */
  recipeJson: string;
  /** Every other `{{name}}` → value, normally `PROMPT_SLUG_LISTS`. */
  variables?: Readonly<Record<string, string>>;
}

/**
 * Compile a prompt's `{{...}}` variables into `promptText` and return the
 * finished system-prompt text.
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
export function compilePrompt(args: CompilePromptInput): string {
  if (!args.promptText.includes(RECIPE_JSON_VARIABLE)) {
    throw new Error(`prompt text has no ${RECIPE_JSON_VARIABLE} occurrence — the model would receive no recipe data`);
  }
  let compiled = args.promptText;
  for (const [name, value] of Object.entries(args.variables ?? {})) {
    compiled = compiled.replaceAll(variableToken(name), value);
  }
  return compiled.replaceAll(RECIPE_JSON_VARIABLE, args.recipeJson);
}
