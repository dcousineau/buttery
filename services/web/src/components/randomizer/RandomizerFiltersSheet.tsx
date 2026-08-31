import type { CollectionSummary, RandomizerFacets } from "#/lib/api";
import type { RandomizerFilterState } from "#/lib/randomizer/draw";
import { CheckboxRow } from "#/components/ui/checkbox";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { Select } from "#/components/ui/select";
import { Label } from "#/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet";

/**
 * The "More filters" sheet (§6.3): Diets · Avoid… · Spice level · Collection ·
 * Include untimed recipes. A right-side `Sheet`, per §12's reconciliation
 * table ("More filters as a right-side sheet" — comp wins over the spec's
 * looser "disclosure").
 *
 * Section headings are **sentence case**, set in Rubik semibold at the body
 * size rather than as tracked-out small caps: the brand is sentence case
 * everywhere — headings, buttons, labels and badges — with no Title Case and
 * no uppercase (design system, "Casing and punctuation"). "AVOID…" in
 * particular reads as a warning shout rather than the quiet, honest label §4.2
 * wants next to that helper text.
 *
 * Every list here is bounded to the slugs `facets` reports for the CURRENT
 * scope (§6.3 / §2.1: "never the full vocabulary") — there is no fallback to
 * a hardcoded diet/allergen vocabulary anywhere in this file.
 */
export function RandomizerFiltersSheet({
  open,
  onOpenChange,
  filters,
  facets,
  collections,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: RandomizerFilterState;
  facets: RandomizerFacets;
  /** From `householdCollectionsQuery` — undefined while it's still loading. */
  collections: CollectionSummary[] | undefined;
  onChange: (patch: Partial<RandomizerFilterState>) => void;
}) {
  function toggle(list: string[], slug: string): string[] {
    return list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug];
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(24rem,92vw)] gap-0 overflow-y-auto p-0 data-[side=right]:w-[min(24rem,92vw)]">
        <SheetHeader>
          <SheetTitle>More filters</SheetTitle>
          <SheetDescription className="sr-only">Diets, allergens to avoid, spice level, collection, and whether to include recipes with no listed time.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {/* Diets */}
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[0.8125rem] font-bold text-foreground">Diets</h3>
            <p className="m-0 text-[0.75rem] text-muted-foreground">Every diet you pick has to be a likely read on the recipe.</p>
            {facets.diets.length === 0 ? (
              <p className="m-0 text-[0.75rem] text-muted-foreground italic">No diet labels in this scope yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {facets.diets.map((option) => (
                  <CheckboxRow
                    key={option.slug}
                    size="sm"
                    tone="selection"
                    checked={filters.diets.includes(option.slug)}
                    onCheckedChange={() => onChange({ diets: toggle(filters.diets, option.slug) })}
                  >
                    {option.label}
                  </CheckboxRow>
                ))}
              </div>
            )}
          </section>

          {/* Avoid… — the allergen exclusion (§4.2, the predicate with teeth). */}
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[0.8125rem] font-bold text-foreground">Avoid…</h3>
            <p className="m-0 text-[0.75rem] text-muted-foreground">Hides recipes we've spotted this in. We can't promise a recipe is free of anything.</p>
            {facets.allergens.length === 0 ? (
              <p className="m-0 text-[0.75rem] text-muted-foreground italic">Nothing spotted in this scope yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {facets.allergens.map((option) => (
                  <CheckboxRow
                    key={option.slug}
                    size="sm"
                    tone="selection"
                    checked={filters.avoidAllergens.includes(option.slug)}
                    onCheckedChange={() => onChange({ avoidAllergens: toggle(filters.avoidAllergens, option.slug) })}
                  >
                    {option.label}
                  </CheckboxRow>
                ))}
              </div>
            )}
          </section>

          {/* Spice level */}
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-[0.8125rem] font-bold text-foreground">Spice level</h3>
            {facets.spiceLevels.length === 0 ? (
              <p className="m-0 text-[0.75rem] text-muted-foreground italic">No spice labels in this scope yet.</p>
            ) : (
              <RadioGroup aria-label="Spice level">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Radio name="spice-level" value="" checked={filters.spiceLevel === null} onChange={() => onChange({ spiceLevel: null })} />
                  Any spice level
                </label>
                {facets.spiceLevels.map((option) => (
                  <label key={option.slug} className="flex items-center gap-2 text-sm text-foreground">
                    <Radio name="spice-level" value={option.slug} checked={filters.spiceLevel === option.slug} onChange={() => onChange({ spiceLevel: option.slug })} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
            )}
          </section>

          {/* Collection */}
          <section className="flex flex-col gap-2">
            <Label htmlFor="randomizer-collection" className="text-[0.8125rem] font-bold text-foreground">
              Collection
            </Label>
            <Select
              id="randomizer-collection"
              size="sm"
              disabled={!collections || collections.length === 0}
              value={filters.collectionId ?? ""}
              onChange={(e) => onChange({ collectionId: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">Every recipe in your box</option>
              {(collections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </section>

          {/* Include untimed recipes — §2.3, default off, opt-in only. */}
          <section>
            <CheckboxRow size="sm" tone="selection" checked={filters.includeUntimed} onCheckedChange={(includeUntimed) => onChange({ includeUntimed })}>
              Include untimed recipes
            </CheckboxRow>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
