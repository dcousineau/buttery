import { CUISINE_SLUGS, LLM_ALLERGEN_SLUGS, LLM_DIET_SLUGS, MEAL_TYPE_SLUGS, SPICE_LEVEL_SLUGS } from "#/workflows/recipe-enrichment/llm/schema.ts";

/**
 * THE PROMPT (plan §4, §6.3) — the one file a human opens to change what the
 * LLM is asked to do. Fallback text, the PostHog prompt's name, and the sole
 * template variable it takes. Nothing else lives here on purpose: no fetch
 * logic, no zod, no I/O. `prompt-fetch.ts` is what tries to replace this text
 * with PostHog's at runtime; `schema.ts` is the enums this prompt restates in
 * English and the zod layer restates as an enforcement boundary.
 *
 * ── This file MIRRORS the PostHog prompt; it does not race to BE it ────────
 * PostHog Prompt Management holds a prompt named `recipe-llm-enrichment`
 * (plan §5.2), edited there and released by moving its `production` label —
 * that is the fast-iteration path, and `prompt-fetch.ts` fetches it fresh on
 * every `llm-enrich` job (subject to its cache). `FALLBACK_PROMPT` below is
 * what runs when that fetch fails for any reason — no key, no PostHog, a
 * timeout, a malformed response — the safety net — and it is ALSO the
 * reviewable copy: PostHog's prompt history lives behind a UI nobody reading
 * a PR diff can see. **Convention (plan §5.2): when a PostHog prompt
 * iteration settles, copy it back into this file in the next PR.** PostHog is
 * the fast path; git is the record. If this file and the live PostHog prompt
 * disagree for a while, that is expected, not a bug — they reconcile at the
 * next settle-and-copy, not continuously.
 *
 * ── Editing this file does NOT bump `LLM_ENRICHMENT_VERSION` ───────────────
 * `LLM_ENRICHMENT_VERSION` (`schema.ts`, L8) tracks the emitted slug sets and
 * the output schema's SHAPE, not the wording that asks for them. Rewording a
 * caution or restructuring a sentence here changes nothing on disk for any
 * already-classified recipe and does not make the corpus backfill-eligible.
 * Only a slug/schema change earns that — and that change belongs in
 * `schema.ts` first, with this file's restated lists following it in the same
 * PR (they are interpolated from `schema.ts` below precisely so they can't
 * drift apart silently).
 */

/**
 * PostHog Prompt Management name (plan §5.2). Contractual: PostHog's prompt
 * must be named exactly this. Prompt names are immutable once created there,
 * so this string and the one typed into the PostHog UI must always match.
 */
export const PROMPT_NAME = "recipe-llm-enrichment";

/**
 * The sole `{{...}}` variable this prompt takes. Model params (temperature,
 * max tokens, retries, timeouts) deliberately stay in code (`provider.ts` /
 * `classify.ts`), not in the prompt's PostHog `config` — a behavior change
 * rides a deploy, not a label move in the PostHog UI (plan §5.2).
 */
export const PROMPT_VARIABLE = "recipe_json";

// Interpolated, not retyped: the zod schema in `schema.ts` is the actual
// enforcement layer (L12), and this prompt is the belt to that schema's
// braces. Hand-copying these lists as loose strings here is exactly the kind
// of drift a closed enum exists to prevent — if a slug is added or removed in
// `schema.ts`, this prompt updates itself the next time it's read, and a
// mismatch between "what the prompt asks for" and "what the schema accepts"
// becomes impossible rather than a thing to remember to keep in sync.
const allergenList = LLM_ALLERGEN_SLUGS.join(", ");
const dietList = LLM_DIET_SLUGS.join(", ");
const cuisineList = CUISINE_SLUGS.join(", ");
const mealTypeList = MEAL_TYPE_SLUGS.join(", ");
const spiceLevelList = SPICE_LEVEL_SLUGS.join(", ");

/**
 * Fallback prompt text (plan §6.3) — a single system prompt, filled with one
 * variable, `{{recipe_json}}` (`PROMPT_VARIABLE` above, matching PostHog's
 * `{{name}}` interpolation syntax). The recipe JSON handed to the model
 * carries the recipe's name, its ingredient lines (each with an `ordinal` and
 * the line's text), and the rules classifier's own labels for the same
 * recipe as context — deliberately, so the model explains disagreement
 * against a second opinion rather than re-deriving everything cold.
 */
export const FALLBACK_PROMPT = `You are a food-classification assistant for a recipe app. You will be given ONE recipe as JSON: its name, its ingredient lines (each carrying an "ordinal" — its position in the recipe — and the ingredient text as written), and "rulesLabels": the verdicts a separate, deterministic rules classifier already reached for this same recipe. Those rules labels are included ON PURPOSE, as context. Your job is to give a second, careful opinion and explain any disagreement — not to re-derive everything from nothing as if the rules classifier did not exist.

## Your task

Emit judgments for exactly the slugs listed below — no others. Every list here is closed and is also enforced by a schema after you respond; inventing a slug outside these lists is always wrong, even if you believe it fits the recipe better than anything listed.

- allergens (verdict is one of contains / may_contain / not_detected): ${allergenList}
- diets (verdict is one of excluded / likely): ${dietList}
- cuisine (at most 2 entries, most-likely first): ${cuisineList}
- meal_type (at most 2 entries): ${mealTypeList}
- spice_level (at most 1 entry, or omit entirely if the dish has no meaningful heat): ${spiceLevelList}

For every allergen or diet judgment you emit, cite the "ordinals" of the ingredient line(s) that justify it. A judgment with no plausible ordinal behind it is worse than no judgment at all.

## Be sparse

Emit ONLY non-default judgments. Do not emit an allergen entry for every allergen you checked and ruled out — omitting a slug already means "not detected" for allergens, and "not excluded" / "not evaluated" for diets. A wall of not_detected entries for every allergen you considered is noise, not thoroughness, and makes real signal harder to find.

## Cautions — read carefully, these are not optional

- "not_detected" is NOT a safety claim. It means you read the ingredient lines and found nothing suggesting that allergen — it is not a certification that the dish is free of it. Cross-contact, "may contain" package warnings, and hidden allergens inside packaged or branded ingredients (a "curry paste", a "stock cube") are all things a text ingredient list alone cannot rule out. Never phrase or imply "not_detected" as "safe" or "free of", including in a "note".
- When you are genuinely unsure whether an allergen is "not_detected" or "may_contain", PREFER "may_contain". A false "may_contain" costs someone a recipe they could have eaten anyway; a false "not_detected" can cost someone a reaction. Err toward the safer verdict.
- The six diets keto, low_carb, low_fat, low_calorie, diabetic, and paleo are NOT nutrition math — you have no per-ingredient macro data. They are ingredient-SHAPE guesses: does the ingredient list look like the shape of a keto dish, a low-carb dish, and so on. Say "likely" for these six ONLY on clear, unambiguous cases, and always keep "confidence" at 0.6 or below for them — even when you are quite sure — because that ceiling is itself a signal to downstream readers that this is a shape guess, not a calculation.
- Disagreeing with a rules label is fine and expected — that is the point of asking you for a second opinion. Explain the disagreement in "note" rather than silently trying to override it; separate merge logic decides what actually gets written, and it is deliberately cautious about downgrades — your output is one input to that decision, not the final word.
- Never invent a slug outside the lists above, never emit a verdict outside the enums given above, and never wrap your JSON in prose, an explanation, or markdown code fences.

## Output

Respond with JSON ONLY — no prose before or after it, no markdown code fences — matching this shape exactly:

{
  "allergens": [{ "slug": "...", "verdict": "contains|may_contain|not_detected", "confidence": 0.0-1.0, "ordinals": [1, 2], "note": "optional, short" }],
  "diets": [{ "slug": "...", "verdict": "excluded|likely", "confidence": 0.0-1.0, "ordinals": [1, 2], "note": "optional, short" }],
  "cuisine": [{ "slug": "...", "confidence": 0.0-1.0 }],
  "mealType": [{ "slug": "...", "confidence": 0.0-1.0 }],
  "spiceLevel": { "slug": "mild|medium|hot", "confidence": 0.0-1.0 } | null
}

Omit any array entirely (send []) or set "spiceLevel" to null when you have nothing non-default to say for that dimension. The recipe JSON follows:

{{recipe_json}}`;
