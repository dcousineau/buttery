import { classify, CLASSIFIER_VERSION, type Label } from "@buttery/food/classify";
import { buildRecipeJson, CLASSIFY_TRIGGER_MESSAGE, compilePrompt, FALLBACK_PROMPT, LLM_ENRICHMENT_VERSION, PROMPT_NAME, PROMPT_SLUG_LISTS } from "@buttery/food/llm";
import { buildApp } from "#/app.ts";
import { buildClassifierLines, loadRecipe } from "#/queues/recipe-enrichment/lib/load.ts";

/**
 * Render, for one or more recipe ids, the EXACT prompt the `llm-enrich` step
 * would send for them — and the rules labels that prompt carries as context.
 *
 *   pnpm --filter @buttery/pipeline prompt <recipeId> [<recipeId>...] [flags]
 *
 *   --posthog   resolve the live PostHog `production` prompt instead of
 *               `FALLBACK_PROMPT` (needs POSTHOG_PERSONAL_API_KEY; silently
 *               degrades to the fallback exactly the way a job would, and says
 *               which one it got)
 *   --json      emit one JSON object per recipe (an array for several) instead
 *               of human-readable text
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * Building an evaluation set. An eval case for this classifier is "this exact
 * prompt text → this expected output", and the prompt text is not something
 * you can retype: it is `@buttery/food/llm`'s template with five slug lists
 * and a `{{recipe_json}}` payload substituted into it, and that payload
 * includes the rules classifier's own verdicts for the same recipe. Hand-
 * assembling it would produce a prompt that drifts from the one production
 * sends, which makes the eval measure the wrong thing.
 *
 * So: the prompt goes to STDOUT and everything else (the recipe header, the
 * rules labels, which prompt source won) goes to STDERR. Piping is the point.
 *
 *   node src/cli/enrichment-prompt.ts <id> > case.txt      # just the prompt
 *   node src/cli/enrichment-prompt.ts <id> <id> --json > cases.json
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * It never calls a model and never writes a row. It reads `recipe` and
 * `recipe_ingredient`, runs the same pure `classify()` the pipeline runs, and
 * prints. Producing the expected output for each case — the other half of an
 * eval pair — is a human's (or a stronger model's) job, done with this prompt
 * in hand.
 *
 * It also does not consult `recipe_enrichment`: the rules labels below are
 * RE-DERIVED here, exactly as `llm-enrich` re-derives them, so what you see is
 * what the prompt would carry today rather than whatever a stale row holds.
 */

interface Invocation {
  recipeIds: string[];
  posthog: boolean;
  json: boolean;
}

function parseArgv(argv: string[]): Invocation {
  return {
    // Recipe ids ARE atproto rkeys and may contain almost anything except a
    // leading `--`; nothing here shape-validates them, per the repo rule.
    recipeIds: argv.filter((arg) => !arg.startsWith("--")),
    posthog: argv.includes("--posthog"),
    json: argv.includes("--json"),
  };
}

/** One recipe's eval case: the compiled prompt plus everything needed to judge it later. */
interface PromptCase {
  recipeId: string;
  recipeName: string;
  /** `local` or `sync` — worth carrying because the pipeline's capture layer treats the two differently. */
  origin: string;
  classifierVersion: number;
  llmVersion: number;
  /** Which prompt text won: `code_fallback` unless `--posthog` reached PostHog. */
  promptSource: string;
  promptName: string;
  promptVersion: number | null;
  rulesLabels: Label[];
  /** The `{{recipe_json}}` payload, as its own field so a dataset can key on it. */
  recipeJson: string;
  /** The compiled system prompt — every variable substituted. THIS is the eval input. */
  systemPrompt: string;
  /** The fixed user turn that follows it. */
  userMessage: string;
}

/** `allergen/milk  contains  0.90  [3, 7]  (dairy-trait)`, one per line — the same ordinals the prompt cites. */
function formatLabels(labels: readonly Label[]): string {
  if (labels.length === 0) return "  (none — the model is being asked cold)";
  return labels
    .map((label) => {
      const ordinals = label.evidence.lines.map((line) => line.ordinal);
      const cited = ordinals.length > 0 ? `[${ordinals.join(", ")}]` : "[]";
      return `  ${label.dimension}/${label.slug}  ${label.verdict}  ${label.confidence.toFixed(2)}  ${cited}  (${label.evidence.rule})`;
    })
    .join("\n");
}

async function main(): Promise<void> {
  const { recipeIds, posthog, json } = parseArgv(process.argv.slice(2));

  // STDOUT is this command's data channel, so every diagnostic — Fastify's
  // boot lines included — goes to STDERR. Without this, `> case.txt` gets a
  // JSON log line ahead of the prompt and the eval case is corrupt.
  const app = await buildApp("cli", { logStream: process.stderr });
  await app.ready();

  if (recipeIds.length === 0) {
    app.log.error("usage: enrichment-prompt <recipeId> [<recipeId>...] [--posthog] [--json]");
    process.exitCode = 2;
    await app.close();
    return;
  }

  // Resolved ONCE for the whole run, not per recipe: every case in one eval
  // set must be built against the same prompt text, or the set is measuring
  // two prompts at once. (`fetchPrompt` never throws — a PostHog failure
  // degrades to FALLBACK_PROMPT and says so through `source`.)
  const prompt = posthog
    ? await app.posthog.fetchPrompt(PROMPT_NAME, FALLBACK_PROMPT)
    : { text: FALLBACK_PROMPT, name: PROMPT_NAME, version: null, source: "code_fallback" as const };

  const cases: PromptCase[] = [];
  try {
    for (const recipeId of recipeIds) {
      const recipe = await loadRecipe(app.db, recipeId);
      if (!recipe) {
        app.log.error({ recipeId }, "no such recipe");
        process.exitCode = 1;
        continue;
      }

      const lines = await buildClassifierLines(recipe.lines);
      const rulesLabels = classify({ recipeName: recipe.name, lines });
      const recipeJson = buildRecipeJson({ recipeName: recipe.name, lines, rulesLabels });

      cases.push({
        recipeId,
        recipeName: recipe.name,
        origin: recipe.origin,
        classifierVersion: CLASSIFIER_VERSION,
        llmVersion: LLM_ENRICHMENT_VERSION,
        promptSource: prompt.source,
        promptName: prompt.name,
        promptVersion: prompt.version,
        rulesLabels,
        recipeJson,
        systemPrompt: compilePrompt({ promptText: prompt.text, recipeJson, variables: PROMPT_SLUG_LISTS }),
        userMessage: CLASSIFY_TRIGGER_MESSAGE,
      });
    }
  } finally {
    await app.close();
  }

  if (cases.length === 0) return;

  if (json) {
    // An array only when asked for several, so a single-recipe run stays a
    // plain object that `jq` and a dataset row both take without unwrapping.
    process.stdout.write(`${JSON.stringify(cases.length === 1 ? cases[0] : cases, null, 2)}\n`);
    return;
  }

  for (const [index, promptCase] of cases.entries()) {
    // Header, labels and separators to STDERR; only the prompt itself to
    // STDOUT, so `> case.txt` yields a file you can paste straight into a
    // model or an eval harness.
    process.stderr.write(
      [
        "",
        `── ${promptCase.recipeName} ──────────────────────────────`,
        `   recipe        ${promptCase.recipeId} (${promptCase.origin})`,
        `   prompt        ${promptCase.promptName} v${promptCase.promptVersion ?? "—"} via ${promptCase.promptSource}`,
        `   versions      classifier@${promptCase.classifierVersion}  llm@${promptCase.llmVersion}`,
        "",
        "   RULES LABELS (the second opinion the model is given):",
        formatLabels(promptCase.rulesLabels),
        "",
      ].join("\n"),
    );

    if (index > 0) process.stdout.write("\n\n");
    process.stdout.write(`${promptCase.systemPrompt}\n`);
    process.stderr.write(`\n   (followed by the fixed user turn: ${JSON.stringify(promptCase.userMessage)})\n`);
  }
}

await main();
