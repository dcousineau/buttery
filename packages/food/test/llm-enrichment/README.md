# LLM enrichment eval cases

Ten recipes, one JSON file each: the exact payload the `llm-enrich` step would
hand the model, and the output we want back. **Fixtures only — there is no
harness yet.** Nothing in this directory is imported by a test, and `vitest`
does not look here.

## What a case file holds

| field              | meaning                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `recipeId`         | the id in the local dev database these were rendered from                                                |
| `origin`           | `local` or `sync` — the capture layer treats the two differently                                         |
| `prompt`           | which prompt text produced the case (`code_fallback` = `FALLBACK_PROMPT` in `src/llm/prompt.ts`)         |
| `versions`         | `CLASSIFIER_VERSION` and `LLM_ENRICHMENT_VERSION` at generation time                                     |
| `recipeJsonSha256` | sha256 of the compact `{{recipe_json}}` string, so a re-render that drifted is detectable without a diff |
| `input`            | the `{{recipe_json}}` payload, parsed: `name`, `ingredients[{ordinal,text}]`, `rulesLabels`              |
| `expected`         | the gold output, shaped exactly like `llmOutputSchema` (`src/llm/schema.ts`)                             |

The **compiled system prompt is deliberately not stored here.** It is ~6 KB of
mostly-identical text per case, and it is regenerable from `recipeId` plus a
prompt version — storing ten copies would rot on the first prompt edit. Get it
back with:

```
pnpm --filter @buttery/pipeline prompt <recipeId> --json     # +--posthog for the live production prompt
```

## How `expected` was produced

Each case's compiled prompt was handed to a separate Opus subagent told to
answer as the model it addresses, as well as it is possible to answer. That
answer is the gold value verbatim — **not reviewed, not corrected.** These are
a starting point for review, not a settled ground truth.

Production runs `google/gemini-2.5-flash-lite` through OpenRouter
(`LLM_ENRICHMENT_MODEL`), chosen by running this set — see `MODEL-RUNS.md`. The gold is deliberately from a stronger model: the
eval measures how close the cheap model gets to the good answer, so the target
must not be the cheap model's own output.

## Regenerating

```
pnpm --filter @buttery/pipeline prompt \
  wb-17004 wb-97769 wb-20354 wb-265289 3mqakeushud26 \
  wb-6351 3mqcwdryomf27 wb-451211 wb-446967 wb-56592 --json
```

Recipe ids are stable in the dev database only. `input` is what makes a case
self-contained; the ids are provenance.

## Open questions for review

These recur across cases and want a decision before the gold is trusted:

1. **`may_contain` vs. a `likely` diet.** The prompt says to prefer
   `may_contain` when unsure. Taken literally, cured meat or a jarred sauce
   earns `wheat: may_contain` on nearly every recipe — which then reads as
   contradicting `gluten_free: likely` on the same recipe. Some cases here lean
   one way, some the other, and the notes carry the hedge instead.
2. **How eagerly to emit the six shape-guess diets.** `keto`, `low_carb`,
   `low_fat`, `low_calorie`, `diabetic` and `paleo` are capped at 0.6, but the
   prompt does not say whether a clear exclusion (sugar, flour) should be
   emitted every time or only when it carries information.
3. **`halal` / `kosher` from an ingredient list.** The rules classifier only
   ever emits `excluded` for these. Cases differ on whether an arguable case
   (vanilla extract's alcohol, unstated slaughter method) is an exclusion or a
   silence.
4. **Scoring.** Slug/verdict sets are comparable exactly; `confidence` and
   `ordinals` are not. A harness probably wants set-equality on
   `(dimension, slug, verdict)`, a tolerance band on confidence, and
   "ordinals ⊆ the recipe's ordinals, non-empty" rather than exact match.
