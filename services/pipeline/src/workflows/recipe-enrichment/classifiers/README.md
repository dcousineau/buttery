# What isn't here, and why

This folder used to emit a label for every allergen slug and every diet slug,
on every recipe, every time — 23 rows per recipe, 828 over the 36-recipe dev
corpus. Two thirds of those rows were `not_detected` or `unknown`, verdicts
nothing downstream reads: the Randomizer's exclusion scan only acts on
`contains`/`may_contain` (allergen) and `excluded` (diet). A label is now
written only when it says something the dimension's default does not
(`types.ts` has the exact table); everything else is absence, and absence is
read as the default. This file is where the next person should look before
wondering whether a missing slug was an oversight. It wasn't — read on.

## The six diet slugs with no rule

`keto`, `low_carb`, `low_fat`, `low_calorie`, `diabetic` and `paleo` used to
live at the bottom of `diet.ts`, each emitting a constant `unknown` label on
every single recipe: the five macro-dependent ones via `macroUnknown` (rule
`macro-dependent-not-yet-computed`, confidence 0), and `paleo` via
`paleoUnknown` (rule `not-specified-in-plan`, confidence 0). Both constants
are gone now, and so are the branches that called them. `EMITTED_DIET_SLUGS`
in `types.ts` is the current list — the seven slugs this module actually has
a rule for — and it is deliberately shorter than the full `diet` vocabulary.

**These six stay in `recipe_vocab` and must not be deleted from it.** They
are not this classifier's concern to begin with: `keto`, `low_carb`,
`low_fat`, `low_calorie`, `diabetic` and `paleo` are upstream
`exchange.recipe.defs#diet*` tokens, seeded into `recipe_vocab` and
`recipe_vocab_alias` by `1785300000000_create_recipe_rendered.ts` alongside
the other eleven diet suffixes. `atproto-sync/lib/render.ts`'s
`resolveToken` reads that table to map **author-declared** diets on
`recipe.suitable_for_diet` when a recipe syncs in from the network — a
separate, upstream-trust path this workflow never touches (`classify.ts`
never reads `suitable_for_diet`, on purpose — see its module doc). Deleting
the vocab rows would break that sync path for every recipe that declares one
of these six diets, for a problem the vocab rows aren't the cause of. The
rule that has nothing to say about them lived here, in the classifier, and
this is where it was removed from.

Five of the six are gone for the same reason: **`keto`, `low_carb`,
`low_fat`, `low_calorie` and `diabetic` need per-ingredient nutrition data**,
and this pipeline has none. The `recipe_enrichment` table already carries the
nutrition columns — `nutrition_method`, `nutrition_confidence`, and the rest
— and they stay null in v1 on purpose (plan §13). The reason is upstream of
this classifier: Open Food Facts, which this pipeline's food lexicon is
already built from, is a product/barcode database, not a nutrient table — it
can tell you a jar of a specific brand of peanut butter exists, not how many
grams of carbohydrate are in 100g of raw chicken breast. The dataset that
answers that is USDA FoodData Central, which means a second ingestion with
its own licence and its own ingredient-name-matching problem on top of the
one the food lexicon already solves. Bringing these five back is a
`nutrition.ts` classifier module (or five branches in `diet.ts`, once the
data justifies more than a stub) reading those now-populated columns, plus a
`CLASSIFIER_VERSION` bump — the same mechanism this change itself used to
retire them.

`paleo` is not that. Nobody has written a rule for paleo, and no amount of
nutrition data would give it one — paleo is not defined by macros, it's
defined by food category (no grains, no legumes, no dairy, no refined sugar),
which is a genuinely different rule shape from anything else in this module.
The absence here is a plan gap, not a missing dependency: `paleo` is available
to specify a rule for whenever someone does.

## Halal and kosher: `excluded`, or nothing

`classifyHalal` and `classifyKosher` used to fall through to an `unknown`
carrying "no rule can certify a kitchen" (rule `no-rule-can-certify-a-kitchen`,
confidence 0.2) whenever nothing excluded the recipe. That sentence is true —
no rule over an ingredient list ever will certify a supervised kitchen — and
it is also not new information to the one audience who would read it.
Somebody keeping kosher already knows they either keep a kitchen to spec or
they don't, and that they have to source certified ingredients regardless of
what an ingredient-list scan says. A label repeating that once per recipe
told them nothing they didn't already know; it just added a row.

Both rules still fire exactly as before: `pork-or-alcohol-tag` for halal,
`pork-alcohol-or-shellfish` and `meat-and-dairy-cooccurrence` for kosher — the
actual exclusions are unchanged and still `excluded`-only, never `likely`
(D6: there is no rule that can positively certify either diet). What's gone
is only the fallback that fired when none of those exclusions matched:
`classifyHalal`/`classifyKosher` now return `null` there, and the recipe
simply has no `diet/halal` or `diet/kosher` row — read, correctly, as "not
excluded," which is all a rule-only certifier could honestly claim anyway.

## Allergen `not_detected`: still a real verdict, just not a stored one

`allergen.ts`'s `classifyOne` still reasons about `not_detected` internally —
every line resolved and none of them carried the allergen — but it no longer
writes it. `not_detected` is the allergen dimension's default (see the
sparse-labels note in `types.ts`), so a row for it would say nothing a
missing row doesn't already say. `unknown` is unaffected and still gets a
row every time it fires — it is the one negative that differs from the
default: `not_detected` means the rules read every line and found nothing,
`unknown` means they could not read every line, and collapsing that
distinction into absence would lose exactly the thing this feature exists to
be careful about.

## If you're adding a slug back

Read the invariant at the top of `types.ts` before you do: absence is only
safe to read as the default for slugs a row's `classifier_version` actually
evaluated. Adding a slug to `ALLERGEN_SLUGS` or `EMITTED_DIET_SLUGS` without
bumping `CLASSIFIER_VERSION` makes every already-classified recipe report the
default for something nothing ever looked at — turning "never evaluated" into
"we checked and found nothing," which for an allergen is the exact failure
this whole feature exists to prevent. `classify.test.ts` pins the emitted
slug sets against the version in a snapshot test for exactly this reason; if
it fails, that's the test working, not a bug in the test. Bump the version,
then run a backfill (`POST /jobs/recipe-enrichment` with
`{"name":"backfill"}` — the version bump alone is what makes every recipe's
row stale and eligible again; `force` is a separate, rarer knob for
reprocessing without a version bump at all) so every recipe re-evaluates
under the new set.
