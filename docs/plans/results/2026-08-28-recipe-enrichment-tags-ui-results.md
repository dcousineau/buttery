# Results: recipe enrichment tags on the recipe display

Execution log for the plan at
[`../2026-08-28-recipe-enrichment-tags-ui.md`](../2026-08-28-recipe-enrichment-tags-ui.md),
on branch `claude/llm-enrichment`.

Enrichment labels now render as a tag strip on both recipe surfaces, sourced
(author / rules / LLM) and — for LLM tags — annotated with a `WandSparkles`
icon and a tooltip carrying the model's own note.

## What landed

| Path                                        | What                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/lib/recipe-tags.ts`                    | **new** — the pure merge, and the only place the verdict policy lives                             |
| `src/lib/recipe-tags.test.ts`               | **new** — the policy pinned as assertions                                                         |
| `src/server/recipe-enrichment.ts`           | `enrichmentTagLabels` + `evidenceNote`; `getRecipeEnrichment`'s first production caller           |
| `src/server/recipe-enrichment.test.ts`      | **new** — mapper + malformed-evidence shapes, no database needed                                  |
| `src/components/recipes/RecipeTagStrip.tsx` | **new** — the one shared component both surfaces render                                           |
| `src/lib/api/types.ts`                      | `suitableForDiet?` + `enrichment?` on `HouseholdRecipeDetail`; `enrichment` on `RecipeDetailData` |
| `src/server/household-recipes.ts`           | selects `suitable_for_diet`; enrichment rides the existing `Promise.all`                          |
| `src/server/recipes.ts`                     | same ride-along on the public loader                                                              |
| `src/components/recipes/DetailPane.tsx`     | strip below `NutritionStrip`                                                                      |
| `src/routes/recipes.$id.tsx`                | old facets block replaced by the strip                                                            |

## The safety rule, and where it is enforced

`not_detected`, `unknown`, and an absent row must never render as "free of".
That is enforced **structurally**, in one function: `allergenTags` filters to
`contains` and `may_contain` and has no `default` branch, so a negative allergen
claim is not a value `mergeRecipeTags` can construct. A reviewer checking the
property reads one function, not the whole feature.

Confidence is enforced the same way: `RecipeTagLabel` has no `confidence` field,
so leaking one is a type error rather than an oversight. The column is untouched
in the database, the merge and the telemetry — it simply never crosses the wire.

## Decisions taken while implementing

**An allergen warning survives the author-wins dedupe.** The plan says the
author wins on collision, so a derived duplicate never gets an AI icon over a
fact a person wrote down — right for cuisine and diets. But an author declaring
"Dairy-free" does not un-say the classifier finding milk, and silencing the
warning is the wrong way to resolve that disagreement. Encoded as a tone check
inside `mergeRecipeTags`, not a special case at a call site.

**The server mapper applies no verdict policy.** `enrichmentTagLabels` passes
every verdict through, including `not_detected`; only `mergeRecipeTags` drops
them. One place owns "what a label may say", and it is the pure module the tests
cover exhaustively — filtering in both would create two definitions of the
safety rule that can drift.

**`crustacean_shellfish` reads as "shellfish".** Broader than the slug, and
deliberately so: a warning may read broader than the finding, never narrower.
The noun map is commented to say no entry may narrow a warning.

## The `RULES_METHOD` flag from the plan's closing note

Confirmed, at the level the environment allows. `RULES_METHOD` is the literal
`"rules@1"` (`packages/food/src/classifiers/shared.ts:12`) while
`CLASSIFIER_VERSION` is `2` (`packages/food/src/classify.ts:54`), and nothing
derives one from the other — so a v2 classifier writes rows tagged `rules@1`.

**Not confirmed against field data:** the local dev database has zero rows in
both `recipe_enrichment_label` and `recipe_enrichment` (queried directly), so
this is a code-read conclusion, not a field observation. Recorded as a defect
with that caveat stated.

It does not affect this feature's source detection, which tests only the `llm:`
prefix and never the tail. It does mean the `title={method}` provenance on a
rules tag misreports which classifier version produced the row.

## Verified

| Check                                                     | Result                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm --filter @buttery/web test`                         | **551 passed** (274 db-gated skipped without `DATABASE_URL`) |
| `pnpm --filter @buttery/web exec vitest run --project db` | **274 passed** against a real migrated Postgres              |
| `pnpm --filter @buttery/web typecheck`                    | clean                                                        |
| `pnpm lint`                                               | 0 errors                                                     |
| `pnpm format:check`                                       | clean                                                        |

New coverage: 18 cases over `mergeRecipeTags` and 16 over `enrichmentTagLabels`.
The two that matter most:

- **The safety rule as an assertion.** An input of only `not_detected` /
  `unknown` / `excluded` rows produces no allergen or diet tags at all, so no
  "free of" claim exists to render. A sibling case proves the filter is
  selective rather than blanket — positive verdicts alongside those rows still
  come through.
- **Malformed `evidence` never throws.** Eight shapes (`null`, a raw JSON
  string, a bare number, an array, an object with no `note`, a numeric `note`,
  an empty `note`, an all-whitespace `note`) all yield `note: null`, plus the
  happy path. That is the whole reason the destructure is defensive and done
  once, server-side.

`confidence` is asserted absent at runtime on both sides, not merely absent
from the type.

## Not verified

**Nothing was rendered in a browser.** Plan verification steps 4 (both surfaces
showing the strip, hover revealing an SQL-set note, `contains` rendering
destructive, `title=rules@N` on rules tags), 5's view-source check, and 6 (the
offline IndexedDB spot-check) were **not** performed. This change should not be
described as visually verified.

The static side of step 5 does hold by construction rather than by inspection:
no tag carries `itemProp`, and both JSON-LD and the microdata are built from raw
author fields with no reference to `enrichment` — so enrichment cannot reach
schema.org output. That is a code-read claim, not a view-source one.

**The manual note-setting step was not run** either. The plan's `UPDATE … SET
evidence = … jsonb_build_object('note', …)` recipe needs enrichment rows to
target, and the local dev database has none (see the `RULES_METHOD` section
above — the same empty tables). So the tooltip's note path is covered by unit
tests over `evidenceNote` and by the component's copy, but no note has been seen
rendered in a tooltip.
