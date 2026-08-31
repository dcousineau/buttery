import { useEffect, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal, Star, X } from "lucide-react";
import type { RandomizerFacets } from "#/lib/api";
import { SKIP_RECENT_DAYS, type RandomizerFilterState } from "#/lib/randomizer/draw";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { cn } from "#/lib/utils";

/**
 * §6.3's fixed time-chip options — "Under 15/30/45/60 min", nothing else.
 * Deliberately NOT facet-driven (unlike meal type / cuisine below): the
 * design comp's time chip is this exact fixed list, and the "unset" option
 * comes from {@link SingleSelectChip}'s own `anyLabel`, so no `null` entry
 * belongs in this array.
 */
const TIME_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: "Under 15 min" },
  { value: 30, label: "Under 30 min" },
  { value: 45, label: "Under 45 min" },
  { value: 60, label: "Under 60 min" },
];

/** How long to wait after the last keystroke before the ingredient text becomes a filter (§6.3: "debounced ~250–300ms"). */
const INGREDIENT_DEBOUNCE_MS = 275;

/**
 * How a chip says "I am set".
 *
 * `--accent` (butter-pale) is the design system's "this one is chosen" fill —
 * the same paint `outline` already uses for hover and `aria-expanded`, and the
 * same one `selectable-row` uses for a chosen row. A set chip is a STATE, not a
 * call to action, so it must not be `--primary`: the roll button beside it is
 * crocker red, and a red chip next to a red CTA makes the filter look like the
 * thing to press. Everything else about the chip — the 2px ink border, the hard
 * shadow, the hover lift and the press sink — keeps coming from the `outline`
 * variant, so the sticker physics are the primitive's, not hand-rolled here.
 */
const SET_CHIP = "data-[set=true]:bg-accent data-[set=true]:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground";

/**
 * §6.3's inline chip row: Meal type · Max time · Cuisine · Favourites · Skip
 * recent, then the ingredient input, then "More filters · N" and (when
 * anything is set) "Clear filters".
 *
 * Every single-select chip (meal type / max time / cuisine) is a
 * `DropdownMenu` over a `DropdownMenuRadioGroup` — never a hand-rolled
 * absolute-positioned div (route plan §6.3: "use the popover or dropdown-menu
 * primitive"). The primitive supplies `aria-expanded`, roving focus and
 * escape-to-close for free.
 *
 * Facet-backed chips (meal type, cuisine) are DISABLED, never hidden, when
 * their facet list is empty in the current scope — a disabled control still
 * announces its name; an absent one just looks like a missing feature.
 */
export function RandomizerFilterBar({
  filters,
  facets,
  hasActiveFilters,
  sheetFilterCount,
  onChange,
  onOpenSheet,
  onClear,
}: {
  filters: RandomizerFilterState;
  facets: RandomizerFacets;
  hasActiveFilters: boolean;
  sheetFilterCount: number;
  onChange: (patch: Partial<RandomizerFilterState>) => void;
  onOpenSheet: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Randomizer filters">
      <SingleSelectChip label="Meal type" anyLabel="Any meal" value={filters.mealType} options={facets.mealTypes} onChange={(mealType) => onChange({ mealType })} />
      <SingleSelectChip label="Max time" anyLabel="Any time" value={filters.maxCookMinutes} options={TIME_OPTIONS} onChange={(maxCookMinutes) => onChange({ maxCookMinutes })} />
      <SingleSelectChip label="Cuisine" anyLabel="Any cuisine" value={filters.cuisine} options={facets.cuisines} onChange={(cuisine) => onChange({ cuisine })} />

      <ToggleChip
        pressed={filters.favoritesOnly}
        onPressedChange={(favoritesOnly) => onChange({ favoritesOnly })}
        icon={<Star aria-hidden="true" className={cn(filters.favoritesOnly && "fill-current")} />}
      >
        Favourites
      </ToggleChip>

      <ToggleChip pressed={filters.skipRecentDays !== null} onPressedChange={(on) => onChange({ skipRecentDays: on ? SKIP_RECENT_DAYS : null })}>
        {filters.skipRecentDays !== null ? `Skipping the last ${SKIP_RECENT_DAYS} days` : "Repeats allowed"}
      </ToggleChip>

      <IngredientInput value={filters.ingredient} onDebouncedChange={(ingredient) => onChange({ ingredient })} />

      <Button variant="outline" size="sm" onClick={onOpenSheet}>
        <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
        More filters{sheetFilterCount > 0 ? ` · ${sheetFilterCount}` : ""}
      </Button>

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X data-icon="inline-start" aria-hidden="true" />
          Clear filters
        </Button>
      )}
    </div>
  );
}

/**
 * A single-select filter chip. `value: null` is "unset" — the "Any …" item in
 * the list, and the label the trigger shows when nothing else is picked.
 * Base UI's `Menu.RadioGroup` value can be `any`, but a menu item's value
 * cannot itself be `null` and still round-trip through `onValueChange`
 * cleanly across every consumer here (`number | null` for time, `string |
 * null` for meal type/cuisine) — so unset is spelled `""` on the wire between
 * this component and the menu, and translated back at the two boundaries.
 */
function SingleSelectChip<V extends string | number>({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: V | null;
  options: Array<{ slug?: string; value?: V; label: string }>;
  onChange: (value: V | null) => void;
}) {
  // Normalize both `RandomizerFacetOption` (`{slug,label}`) and the time
  // chip's literal `{value,label}` list to one `{value, label}` shape.
  const normalized = options.map((o) => ({ value: (o.value ?? o.slug) as V, label: o.label }));
  const disabled = normalized.length === 0;
  const current = normalized.find((o) => o.value === value);
  const currentStr = value === null ? "" : String(value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        title={disabled ? `No ${label.toLowerCase()} to filter on yet` : undefined}
        // The visible text is the VALUE ("Dinner"), which on its own says
        // nothing about which dimension it filters — so the accessible name
        // carries the dimension too. The visible label is kept as a prefix of
        // the accessible name, per WCAG 2.5.3 (label in name).
        aria-label={`${label}: ${current ? current.label : anyLabel}`}
        render={
          <Button variant="outline" size="sm" data-set={current ? "true" : undefined} className={SET_CHIP}>
            {current ? current.label : anyLabel}
            <ChevronDown data-icon="inline-end" aria-hidden="true" className="opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={currentStr}
          onValueChange={(next: string) => {
            if (next === "") {
              onChange(null);
              return;
            }
            const match = normalized.find((o) => String(o.value) === next);
            onChange(match?.value ?? null);
          }}
        >
          {/* `closeOnClick` — Base UI's `Menu.RadioItem` keeps the menu open by
            default, which is right for a group you keep adjusting and wrong
            here: a single-select filter has nothing left to pick, so the menu
            just sits over the pool line and the result it has already changed.
            (Left open, it also traps the next click behind Base UI's inert
            backdrop until Escape.) */}
          <DropdownMenuRadioItem closeOnClick value="">
            {anyLabel}
          </DropdownMenuRadioItem>
          {normalized.map((o) => (
            <DropdownMenuRadioItem closeOnClick key={String(o.value)} value={String(o.value)}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * An on/off filter chip: `Button variant="outline"` + `aria-pressed`, rather
 * than `Switch` — the design system reserves `Switch` for persistent settings
 * ("keep the screen awake"), and a filter chip is closer kin to a toggleable
 * action. Its set paint is {@link SET_CHIP}, the same one the single-select
 * chips use, so "set" looks like one thing across the whole bar.
 */
function ToggleChip({
  pressed,
  onPressedChange,
  icon,
  children,
}: {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Button type="button" variant="outline" size="sm" aria-pressed={pressed} onClick={() => onPressedChange(!pressed)} className={SET_CHIP}>
      {icon}
      {children}
    </Button>
  );
}

/**
 * The ingredient text chip. Local, un-debounced state drives the visible
 * input (so typing never stutters); `onDebouncedChange` fires
 * `INGREDIENT_DEBOUNCE_MS` after the last keystroke, which is what actually
 * refetches the pool (§6.3: "must be debounced … so typing does not fire a
 * request per keystroke").
 */
function IngredientInput({ value, onDebouncedChange }: { value: string; onDebouncedChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A filter cleared elsewhere (the sheet's "Clear filters", widening) must be
  // reflected here even though this input owns its own draft state.
  const lastCommitted = useRef(value);
  useEffect(() => {
    if (value !== lastCommitted.current) {
      setDraft(value);
      lastCommitted.current = value;
    }
  }, [value]);

  function onInput(next: string) {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastCommitted.current = next;
      onDebouncedChange(next);
    }, INGREDIENT_DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return <Input size="sm" value={draft} onChange={(e) => onInput(e.target.value)} placeholder="Has an ingredient…" aria-label="Ingredient contains" className="w-40" />;
}
