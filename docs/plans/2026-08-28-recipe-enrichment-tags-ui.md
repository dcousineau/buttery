# Recipe enrichment tags on the recipe display

## Context

The enrichment pipeline now classifies recipes (allergens, cuisine, meal type, spice level, diets) via rules + LLM passes, but nothing user-facing renders it. This adds a tag strip below nutritional information on **both** recipe surfaces — the signed-in household `DetailPane` and the public recipe page (per user: "on the recipe display" always means both) — via **one shared component**, so future DetailPane/public-page unification inherits it for free.

Each tag shows its **source**: author-declared (raw recipe), rules classifier, or LLM. LLM tags get a `WandSparkles` (lucide) icon. Reasoning text rides in a tooltip — reusing the **existing** `evidence.note` field the LLM already fills for allergens/diets (`schema.ts:126,142,153`); no LLM/prompt changes in scope. Confidence numbers are a **display-only drop**: rules-side values are hardcoded tier constants (0.95/0.65/… in `packages/food/src/classifiers/allergen.ts:84-89`), not calibrated probabilities — misleading to show. The column stays (it powers the top-2 cuisine tie-break in `merge.ts:301-304` and disagreement telemetry); it simply never crosses the wire to the UI.

### Key facts the design rests on

- `recipe_enrichment_label` PK is `(recipe_id, dimension, slug)` — one row per slug; rules-vs-LLM merge already happened at write time. Source is derived per-row from `method` (`llm:` prefix vs `rules@N`), idiom at `server/recipe-debug.ts:537`.
- Ready-made read seam: `getRecipeEnrichment(db, recipeId)` at `services/web/src/server/recipe-enrichment.ts:159-188` — returns labels grouped by dimension, evidence verbatim, `null` when never enriched. Zero production callers today; this feature is its first.
- **Hard safety rule** (`recipe-enrichment.ts:23-73` + schema comments): `not_detected` or an absent row must NEVER render as "free of"/"safe". Labels are sparse — absence is the default.
- Raw sources: `recipe.recipe_cuisine`, `recipe_category`, `cooking_method`, `suitable_for_diet` (allergens exist only in enrichment, by design).
- `evidence` is untyped `JsonValue` at the read boundary — note extraction destructures defensively, once, server-side.

## Architecture decisions

1. **Ship enrichment labels on existing detail payloads; merge client-side in a pure function.** Riding along in `getHouseholdRecipe` keeps enrichment inside the offline IndexedDB cache; the pure merge is unit-testable and satisfies "fetch separately, merge at display time" — the wire carries per-label source, the client merges with author facets.
2. **Confidence never crosses the wire.** Wire type has no `confidence` field — leak is unrepresentable at the display boundary. DB/merge/telemetry/devtools untouched. No migration.
3. **Evidence collapsed to `note: string | null` server-side** (one defensive destructure; small payloads).
4. **Source: `author | rules | llm` at display time**; author facets tagged in the merge.
5. **LLM tags: WandSparkles icon + tooltip always** ("Identified by AI — {note}" when note present, else "Identified by AI"). Rules tags: tooltip (`note ?? "Detected from the ingredient list"`), `title={method}` provenance. Author tags: plain badge. Icon needs a decoder → tooltip even without note. Provenance is supplementary, so the design-system "no essential info in tooltips" rule holds — the verdict is always in badge text. Touch/no-hover: accepted v1 gap, mitigated with `sr-only` "(identified by AI)" span (also serves screen readers).
6. **Verdict policy, encoded in the merge function only:**
   - allergen `contains` → "Contains X", `may_contain` → "May contain X", both `destructive` Badge. `not_detected`/`unknown` dropped; no "free of" state constructible.
   - diet `likely` → tag; `excluded`/`unknown` dropped in v1 (negative claims are noise; author declaration stands).
   - cuisine/meal_type/spice_level (always `likely`) → rendered.

## Files

### New

**`services/web/src/lib/recipe-tags.ts`** — pure, client-safe merge logic (lib/ for logic, components/ for components, per house pattern).

```ts
export interface RecipeTagLabel {
  // one enrichment label off the wire; no confidence, by design
  dimension: "allergen" | "diet" | "cuisine" | "meal_type" | "spice_level";
  slug: string;
  verdict: string;
  source: "rules" | "llm";
  note: string | null; // evidence.note, extracted server-side
  method: string; // full provenance for title attr
}

export interface RecipeTag {
  key: string; // "allergen:milk", "author:cuisine:Italian"
  group: "allergen" | "diet" | "cuisine" | "meal" | "spice" | "facet";
  label: string; // final copy, e.g. "May contain tree nuts"
  source: "author" | "rules" | "llm";
  tone: "warning" | "neutral"; // warning ⇒ destructive Badge (allergens only)
  note: string | null;
  method: string | null; // null for author tags
}

export function mergeRecipeTags(input: {
  author: { cuisine: string | null; category?: string | null; cookingMethod?: string | null; diets: string[] };
  labels: RecipeTagLabel[] | null | undefined; // null = never enriched; undefined = pre-feature cached payload
}): RecipeTag[];
```

Internals: order = allergens (contains before may_contain, then alpha) → diets → cuisine → meal type → spice → author-only facets. Dedupe by normalized label; **author wins** on collision (no AI icon on author-declared facts). Humanization: `RECIPE_VOCAB` `labelForSlug` + local override map for pipeline-only slugs (`tex_mex` → "Tex-Mex", `cajun_creole` → "Cajun & Creole", `southern_us` → "Southern US", `north_african`/`west_african`/`eastern_european`/`middle_eastern`, `dairy_free`, `pescatarian`), `startCase` fallback for unknown future slugs. Allergen nouns lowercased into sentences (`tree_nuts` → "tree nuts"; `crustacean_shellfish` → "shellfish" — broader warning, never narrower). Spice copy: "Mild spice" / "Medium spice" / "Hot & spicy". Known cosmetic dedupe miss `southern` vs `southern_us` — document in comment.

**`services/web/src/lib/recipe-tags.test.ts`** — unit tests: `labels: null` and `undefined` → author-only; `not_detected`/`unknown`/`excluded` dropped; contains/may_contain copy + warning tone; author-wins dedupe (cuisine + diet); pipeline-only slug humanization; ordering; empty → `[]`; note passthrough.

**`services/web/src/components/recipes/RecipeTagStrip.tsx`** — the one shared component.

```tsx
export function RecipeTagStrip(props: {
  author: { cuisine: string | null; category?: string | null; cookingMethod?: string | null; diets: string[] };
  labels: RecipeTagLabel[] | null | undefined;
  className?: string;
}); // mergeRecipeTags → render; returns null when empty (NutritionStrip idiom)
```

- `flex flex-wrap gap-2`; allergens `<Badge variant="destructive" size="xs">`, all else `<Badge variant="outline" size="xs">` (design system: outline = metadata/facet tag, matches `recipes.$id.tsx:211`).
- LLM: `<WandSparkles data-icon="inline-end" aria-hidden />` in Badge (badge.tsx styles `data-icon` slots), `sr-only` "(identified by AI)", `Tooltip`/`TooltipTrigger render={<Badge … tabIndex={0} />}`/`TooltipContent`. `TooltipProvider` already app-wide (`AppShell.tsx:96`, wraps public routes too).
- Rules: no icon; tooltip fallback line; `title={method}`.
- No `itemProp` on any derived tag (enrichment "NEVER PUBLISHED", `recipe-enrichment.ts:18-21`).
- `data-source={tag.source}` on each badge for tests/debugging.

### Modified

**`services/web/src/server/recipe-enrichment.ts`** — add `LLM_METHOD_PREFIX = "llm:"` (restated, not imported from pipeline — same reasoning as `recipe-debug.ts:521-526`) and `enrichmentTagLabels(view: RecipeEnrichmentView | null): RecipeTagLabel[] | null` — source from method prefix, defensive `evidence.note` pull, confidence dropped. New unit test `server/recipe-enrichment.test.ts` for malformed evidence shapes (module imports are types-only; no db needed).

**`services/web/src/lib/api/types.ts`** — `HouseholdRecipeDetail`: add `suitableForDiet?: string[]`, `enrichment?: RecipeTagLabel[] | null` — **optional** with the same stale-IndexedDB comment as `plannedUsage` (`types.ts:104-110`). `RecipeDetailData`: add `enrichment: RecipeTagLabel[] | null` (loader path, never cached).

**`services/web/src/server/household-recipes.ts`** (`getHouseholdRecipe`) — select `r.suitable_for_diet`; add `getRecipeEnrichment(db, recipeId)` to the existing `Promise.all` (:273-286, same ride-along pattern as `readPlannedUsage`); payload gains `suitableForDiet: (row.suitable_for_diet ?? []).map(prettify).filter(Boolean)` (import `prettify` from `#/lib/recipe-provenance`) and `enrichment: enrichmentTagLabels(view)`.

**`services/web/src/server/recipes.ts`** (`getRecipe`) — add `getRecipeEnrichment` to `Promise.all` (:155-160); payload gains `enrichment`. JSON-LD and meta microdata untouched (built from raw fields only — verified derived facts cannot leak into schema.org output).

**`services/web/src/components/recipes/DetailPane.tsx`** — directly after `<NutritionStrip … />` at :405:

```tsx
<RecipeTagStrip author={{ cuisine: recipe.cuisine, category: recipe.category, diets: recipe.suitableForDiet ?? [] }} labels={recipe.enrichment} />
```

**`services/web/src/routes/recipes.$id.tsx`** — delete `facets` array (:126) + facets block (:208-216); render the same `RecipeTagStrip` (passing `cookingMethod` too). Everything the old block showed still renders, as author-sourced tags. `RecipeView.tsx` (create-preview) untouched.

## Data flow

```
recipe_enrichment_label (sparse; method rules@N | llm:*; evidence.note?)
   └─ getRecipeEnrichment(db, id)          [first production use of the seam]
        └─ enrichmentTagLabels(view)       [source from method prefix; note from evidence; confidence dropped]
             ├─ getHouseholdRecipe .enrichment? ── react-query ── IndexedDB (offline rides along)
             └─ getRecipe .enrichment           ── route loader (SSR)
                        └─ RecipeTagStrip ── mergeRecipeTags(author facets ⊕ labels)
                              └─ Badge (+ WandSparkles + Tooltip for llm; Tooltip for rules)
```

## Edge cases

- Never-enriched recipe → `null` → author tags only.
- Sparse/`not_detected`/`unknown`/`excluded` → dropped; no "free of" tag constructible (safety rule structurally satisfied).
- Pre-feature IndexedDB payloads → optional fields + guards; enrichment appears on next refetch. Accepted staleness, no new invalidation wiring.
- Missing note → generic tooltip line.
- Unknown future slug → `startCase`, never crashes.

## Manual test: set a note once (out-of-scope LLM work simulated)

```sh
cd services/web && railway run --service buttery -- psql "$DATABASE_URL" -c "
  UPDATE recipe_enrichment_label
  SET evidence = coalesce(evidence, '{}'::jsonb)
      || jsonb_build_object('note', 'Butter and parmesan both carry milk.')
  WHERE recipe_id = '<RECIPE_ID>' AND dimension = 'allergen' AND slug = 'milk';"
```

Candidates: `SELECT recipe_id, dimension, slug, method, evidence->>'note' FROM recipe_enrichment_label LIMIT 20;`. Same `||` update on a `cuisine` row exercises icon-without-note. Display-only; next enrichment run overwrites.

## Verification

1. `pnpm --filter @buttery/web test` — new unit suites, no db needed.
2. `pnpm --filter @buttery/web test:db` — existing `recipe-enrichment.db.test.ts` green; optionally extend with jsonb-note round-trip through `getRecipeEnrichment` → `enrichmentTagLabels`.
3. `pnpm --filter @buttery/web typecheck`.
4. Dev stack (`pnpm dev`, pg 55432): DetailPane shows strip below Nutrition card; public page shows strip where facets were; `contains` renders destructive; LLM tags show WandSparkles; hover shows SQL-set note; rules tags show generic line with `title=rules@1`.
5. No confidence anywhere (structurally impossible — not on the wire); view-source: JSON-LD/microdata unchanged, no enrichment slugs.
6. Offline spot-check: load boxed recipe online → offline → revisit → tags render from cache.

Implementation order: lib + tests → server mapper + unit test → types → server fns → component → both surfaces → verification.

## Out of scope (explicit)

- LLM prompt/schema changes (notes for cuisine/meal_type/spice_level need `LLM_ENRICHMENT_VERSION` bump).
- Confidence schema drop (revisit later; display drop is complete for now).
- DetailPane/public-page unification (this plan only guarantees the shared `RecipeTagStrip` so unification won't redo it).
- `RecipeView.tsx` create-preview.

## Note for implementer

- **Results log**: record what you actually did — deviations from this plan, surprises, verification output — in `docs/plans/results/2026-08-28-recipe-enrichment-tags-ui-results.md` as you go, per repo convention.
- The three headline planning decisions (display-only confidence drop over schema drop; client-side merge on existing payloads over a separate server fn; diet `excluded` hidden in v1) are already in the coherence journal (`d-b2e4141b`, `d-116717bc`, `d-b02a26c4`). Log your own implementation decisions as you make them.
- Flag while you're in there: `RULES_METHOD = "rules@1"` in `packages/food/src/classifiers/shared.ts:12` is stale vs `CLASSIFIER_VERSION = 2` — method tails on rules rows misreport the version. Doesn't break the `llm:` source check this plan relies on, but worth a `conjecture`/`defect` entry (confirm against a live DB first).
