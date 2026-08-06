import { useEffect, useRef, useState, type Ref } from "react";
import { Link } from "@tanstack/react-router";
import { Clock, Copy, Dices, ExternalLink, RotateCcw, ShoppingBasket, Sparkles, UtensilsCrossed } from "lucide-react";
import { getHouseholdRecipe, type HouseholdRecipeDetail } from "#/server/household-recipes";
import { getRandomizerPool, type GetRandomizerPoolInput, type GetRandomizerPoolResult, type RandomizerCard } from "#/server/randomizer";
import { buildShareText, drawRandom } from "#/lib/randomizer-draw";
import { Button } from "#/components/ui/button";
import { Select } from "#/components/ui/select";
import { Input } from "#/components/ui/input";
import { Checkbox } from "#/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Card, CardContent } from "#/components/ui/card";
import { Spinner } from "#/components/ui/spinner";
import { useRecipesView } from "./context";

/**
 * The meal randomizer (plan §5, §6): a filter bar over the household box, a
 * "What should I make?" draw, re-roll with no-repeat, corpus widening on an
 * empty/thin box pool, a shopping list, and plain-text copy/share.
 *
 * Filters change ⇒ refetch the box pool from `getRandomizerPool`; rolls never
 * hit the server (the client owns the draw over the already-fetched pool, per
 * `randomizer-draw.ts`). The corpus pool (opt-in widening) is tracked
 * separately from the box pool — editing any filter drops the corpus pool and
 * returns to drawing from the box.
 */
export function Randomizer({ initial }: { initial: GetRandomizerPoolResult }) {
  // --- filters --------------------------------------------------------
  const [cuisine, setCuisine] = useState("");
  const [category, setCategory] = useState("");
  const [includeUntimed, setIncludeUntimed] = useState(false);

  // Ingredient + max-cook-time are free text/number entry — debounced so
  // filter refetches don't fire per keystroke. `*Text` is the live input
  // value; the bare name is the committed value the fetch effect watches.
  const [ingredientText, setIngredientText] = useState("");
  const [ingredient, setIngredient] = useState("");
  const ingredientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [maxCookMinutesText, setMaxCookMinutesText] = useState("");
  const [maxCookMinutes, setMaxCookMinutes] = useState("");
  const maxCookTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onIngredientChange(value: string) {
    setIngredientText(value);
    if (ingredientTimer.current) clearTimeout(ingredientTimer.current);
    ingredientTimer.current = setTimeout(() => setIngredient(value.trim()), 300);
  }

  function onMaxCookMinutesChange(value: string) {
    setMaxCookMinutesText(value);
    if (maxCookTimer.current) clearTimeout(maxCookTimer.current);
    maxCookTimer.current = setTimeout(() => setMaxCookMinutes(value), 300);
  }

  useEffect(
    () => () => {
      if (ingredientTimer.current) clearTimeout(ingredientTimer.current);
      if (maxCookTimer.current) clearTimeout(maxCookTimer.current);
    },
    [],
  );

  function parsedMaxCookMinutes(): number | undefined {
    const trimmed = maxCookMinutes.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function buildInput(source: "box" | "corpus"): GetRandomizerPoolInput {
    return {
      cuisine: cuisine || undefined,
      category: category || undefined,
      maxCookMinutes: parsedMaxCookMinutes(),
      includeUntimed,
      ingredient: ingredient || undefined,
      source,
    };
  }

  // --- pools ------------------------------------------------------------
  const [boxResult, setBoxResult] = useState(initial);
  const [boxLoading, setBoxLoading] = useState(false);
  const [corpusResult, setCorpusResult] = useState<GetRandomizerPoolResult | null>(null);
  const [corpusLoading, setCorpusLoading] = useState(false);
  const [activeSource, setActiveSource] = useState<"box" | "corpus">("box");

  const [drawn, setDrawn] = useState<RandomizerCard | null>(null);
  const [lastRecipeId, setLastRecipeId] = useState<string | null>(null);

  const currentPool = activeSource === "corpus" ? (corpusResult?.pool ?? []) : boxResult.pool;

  // Refetch the box pool whenever a filter changes (plan §4/§5.5). Skip the
  // very first run — the route loader already fetched the unfiltered box pool
  // for the initial paint. Widening (a separate, explicit action) is dropped
  // on any filter edit so re-opening the filters returns to the box.
  const didMount = useRef(false);
  const fetchId = useRef(0);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    let cancelled = false;
    const id = ++fetchId.current;
    setBoxLoading(true);
    setCorpusResult(null);
    setActiveSource("box");
    setDrawn(null);
    setLastRecipeId(null);
    getRandomizerPool({ data: buildInput("box") })
      .then((res) => {
        if (!cancelled && id === fetchId.current) setBoxResult(res);
      })
      .finally(() => {
        if (!cancelled && id === fetchId.current) setBoxLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildInput closes over the same deps listed here
  }, [cuisine, category, includeUntimed, maxCookMinutes, ingredient]);

  function clearAll() {
    if (ingredientTimer.current) clearTimeout(ingredientTimer.current);
    if (maxCookTimer.current) clearTimeout(maxCookTimer.current);
    setCuisine("");
    setCategory("");
    setIncludeUntimed(false);
    setIngredientText("");
    setIngredient("");
    setMaxCookMinutesText("");
    setMaxCookMinutes("");
  }

  async function widen() {
    setCorpusLoading(true);
    try {
      const res = await getRandomizerPool({ data: buildInput("corpus") });
      setCorpusResult(res);
      setActiveSource("corpus");
      const card = drawRandom(res.pool, null);
      setDrawn(card);
      setLastRecipeId(card?.recipeId ?? null);
    } finally {
      setCorpusLoading(false);
    }
  }

  function draw() {
    const card = drawRandom(currentPool, lastRecipeId);
    setDrawn(card);
    setLastRecipeId(card?.recipeId ?? null);
  }

  // --- focus management (plan §6 / accessibility) ------------------------
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (drawn) resultRef.current?.focus({ preventScroll: true });
  }, [drawn]);

  const loading = boxLoading || corpusLoading;
  const rerollDisabled = currentPool.length <= 1;
  const drawDisabled = currentPool.length === 0 || loading;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-[42rem] flex-col gap-4 px-5 pt-4 pb-8">
        <div className="flex flex-col gap-1">
          <h1 className="display-title m-0 text-[1.625rem] leading-[1.1] text-balance text-foreground">What should I make?</h1>
          <p className="m-0 text-sm text-muted-foreground">Filter your shelf, then let it decide.</p>
        </div>

        <FilterBar
          cuisine={cuisine}
          category={category}
          includeUntimed={includeUntimed}
          ingredientText={ingredientText}
          maxCookMinutesText={maxCookMinutesText}
          facets={boxResult.facets}
          onCuisine={setCuisine}
          onCategory={setCategory}
          onIncludeUntimed={setIncludeUntimed}
          onIngredientText={onIngredientChange}
          onMaxCookMinutesText={onMaxCookMinutesChange}
          onClearAll={clearAll}
        />

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="xl" onClick={draw} disabled={drawDisabled} aria-disabled={drawDisabled}>
            <Dices data-icon="inline-start" aria-hidden="true" />
            What should I make?
          </Button>
        </div>

        {/* Pool-size status is a status message for non-sighted users. */}
        <div className="sr-only" role="status" aria-live="polite">
          {loading ? "Loading recipes…" : `${currentPool.length} recipe${currentPool.length === 1 ? "" : "s"} match your filters.`}
        </div>

        {loading && !drawn ? (
          <div className="flex justify-center py-8">
            <Spinner aria-hidden className="size-6 text-muted-foreground" />
          </div>
        ) : currentPool.length === 0 ? (
          <EmptyPoolState canWiden={activeSource === "box"} widening={corpusLoading} onWiden={widen} />
        ) : drawn ? (
          <ResultCard ref={resultRef} card={drawn} rerollDisabled={rerollDisabled} onReroll={draw} />
        ) : (
          <p className="m-0 text-center text-sm text-muted-foreground">
            {currentPool.length} recipe{currentPool.length === 1 ? "" : "s"} match — hit the button above.
          </p>
        )}
      </div>
    </div>
  );
}

function FilterBar({
  cuisine,
  category,
  includeUntimed,
  ingredientText,
  maxCookMinutesText,
  facets,
  onCuisine,
  onCategory,
  onIncludeUntimed,
  onIngredientText,
  onMaxCookMinutesText,
  onClearAll,
}: {
  cuisine: string;
  category: string;
  includeUntimed: boolean;
  ingredientText: string;
  maxCookMinutesText: string;
  facets: GetRandomizerPoolResult["facets"];
  onCuisine: (v: string) => void;
  onCategory: (v: string) => void;
  onIncludeUntimed: (v: boolean) => void;
  onIngredientText: (v: string) => void;
  onMaxCookMinutesText: (v: string) => void;
  onClearAll: () => void;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="randomizer-cuisine">Cuisine</FieldLabel>
              <Select id="randomizer-cuisine" value={cuisine} onChange={(e) => onCuisine(e.target.value)}>
                <option value="">Any cuisine</option>
                {facets.cuisines.map((f) => (
                  <option key={f.slug} value={f.slug}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGroup>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="randomizer-category">Meal type</FieldLabel>
              <Select id="randomizer-category" value={category} onChange={(e) => onCategory(e.target.value)}>
                <option value="">Any meal type</option>
                {facets.categories.map((f) => (
                  <option key={f.slug} value={f.slug}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGroup>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="randomizer-max-time">Max cook time (minutes)</FieldLabel>
              <Input
                id="randomizer-max-time"
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="Any"
                value={maxCookMinutesText}
                onChange={(e) => onMaxCookMinutesText(e.target.value)}
              />
            </Field>
          </FieldGroup>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="randomizer-ingredient">Ingredient contains</FieldLabel>
              <Input id="randomizer-ingredient" type="text" placeholder="e.g. chicken" value={ingredientText} onChange={(e) => onIngredientText(e.target.value)} />
            </Field>
          </FieldGroup>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-(--cursor-interactive) items-center gap-2 text-sm font-medium text-foreground">
            <Checkbox
              checked={includeUntimed}
              disabled={!maxCookMinutesText.trim()}
              onChange={(e) => onIncludeUntimed(e.target.checked)}
              aria-label="Include recipes with no recorded cook time"
            />
            Include untimed recipes
          </label>
          <Button variant="ghost" size="sm" onClick={onClearAll}>
            Clear all
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyPoolState({ canWiden, widening, onWiden }: { canWiden: boolean; widening: boolean; onWiden: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <UtensilsCrossed className="size-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p className="m-0 text-[0.9375rem] font-bold text-foreground">No recipes match these filters.</p>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">Try loosening a filter, or clear them all.</p>
      </div>
      {canWiden && (
        <Button variant="outline" onClick={onWiden} disabled={widening} aria-disabled={widening}>
          {widening ? <Spinner aria-hidden className="size-4" /> : <Sparkles data-icon="inline-start" aria-hidden="true" />}
          Roll from the whole collection instead?
        </Button>
      )}
    </div>
  );
}

function ResultCard({ ref, card, rerollDisabled, onReroll }: { ref: Ref<HTMLDivElement>; card: RandomizerCard; rerollDisabled: boolean; onReroll: () => void }) {
  return (
    <div ref={ref} tabIndex={-1} className="flex flex-col gap-3 outline-none">
      <Card className="overflow-hidden">
        <div className="relative aspect-[16/9] w-full overflow-hidden border-b-2 border-border bg-muted">
          {card.thumbUrl ? (
            <img src={card.thumbUrl} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <div className="grid size-full place-content-center">
              <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
            </div>
          )}
        </div>
        <CardContent className="flex flex-col gap-2">
          <Link to="/household/recipes/$id" params={{ id: card.recipeId }} className="display-title m-0 text-xl text-balance text-foreground no-underline hover:underline">
            {card.title}
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] font-semibold text-muted-foreground">
            {/* RandomizerCard carries a source LABEL, not the glyph-keyed `kind`
             * (§4.2) — plain text here rather than guessing at `<SourceIcon>`'s
             * kind. An external-link glyph only when there's actually a link. */}
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {card.sourceUrl && <ExternalLink className="size-3.5" aria-hidden="true" />}
              {card.sourceLabel}
            </span>
            {card.totalTimeDisplay && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Clock className="size-3.5" aria-hidden="true" />
                  {card.totalTimeDisplay}
                </span>
              </>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={onReroll} disabled={rerollDisabled} aria-disabled={rerollDisabled}>
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              Roll again
            </Button>
            <Button variant="outline" render={<Link to="/household/recipes/$id" params={{ id: card.recipeId }} />} nativeButton={false}>
              View full recipe
            </Button>
          </div>
          {rerollDisabled && <p className="m-0 text-xs text-muted-foreground">Only one match — nothing else to roll.</p>}
        </CardContent>
      </Card>

      {/* Keyed by recipeId so a new draw remounts fresh (favorite/scroll-style
       * reset, same pattern as `DetailPane`/`NoteEditor`) instead of clearing
       * stale ingredients via a setState-in-effect. */}
      <ShoppingList key={card.recipeId} recipeId={card.recipeId} title={card.title} totalTimeDisplay={card.totalTimeDisplay} sourceUrl={card.sourceUrl} />
    </div>
  );
}

/**
 * The drawn recipe's ingredient list (plan §7) + one-tap plain-text copy
 * (plan §8). Reuses `getHouseholdRecipe` rather than a new query — but that
 * server function's authorization is BOX membership, not `visibility=public`,
 * so a corpus-widened (not-yet-boxed) recipe returns `null` here. That's the
 * same "not in your box" outcome the `$id` detail route already renders for
 * an unboxed id, not a new failure mode this feature introduces.
 */
function ShoppingList({ recipeId, title, totalTimeDisplay, sourceUrl }: { recipeId: string; title: string; totalTimeDisplay: string | null; sourceUrl: string | null }) {
  const { pushToast } = useRecipesView();
  const [detail, setDetail] = useState<HouseholdRecipeDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getHouseholdRecipe({ data: { recipeId } })
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  async function onShare() {
    if (!detail) return;
    const text = buildShareText({ title, ingredients: detail.ingredients, totalTimeDisplay, sourceUrl });
    await navigator.clipboard.writeText(text);
    pushToast("Copied to clipboard");
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="display-title m-0 flex items-center gap-1.5 text-base text-foreground">
            <ShoppingBasket className="size-4" aria-hidden="true" />
            Shopping list
          </h2>
          <Button variant="outline" size="sm" onClick={onShare} disabled={!detail} aria-disabled={!detail}>
            <Copy data-icon="inline-start" aria-hidden="true" />
            Copy
          </Button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner aria-hidden className="size-4" />
            Loading ingredients…
          </div>
        ) : detail ? (
          detail.ingredients.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {detail.ingredients.map((line, i) => (
                <li key={i} className="flex gap-2 text-[0.8125rem] leading-[1.35] text-foreground">
                  <span className="mt-[5px] size-[5px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">No ingredients listed.</p>
          )
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            Not in your box yet — add it from{" "}
            <Link to="/household/recipes/$id" params={{ id: recipeId }} className="underline">
              the recipe page
            </Link>{" "}
            to see its shopping list.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
