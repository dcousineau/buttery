/**
 * Consolidate parsed, categorized ingredient lines into grocery rows (plan §5.2).
 *
 * This is the module that makes the feature more than a join query: `1 lb
 * chicken breast` from one recipe and `8 oz chicken breast` from another become
 * a single row reading `1 lb 8 oz`, with both recipes named under it.
 *
 * Pure — no DB, no DOM. The server calls it to build a preview and to compute a
 * commit; the browser can call the identical code offline.
 *
 * ## What merges
 *
 * Two contributions merge iff **same identity** and **same merge key**:
 *
 * - Identity is the Open Food Facts `foodSlug`, falling back to the normalized
 *   name when the line did not match (plan D6). A null-slug contribution never
 *   merges with a slug one, even when the text looks similar — that asymmetry is
 *   deliberate, because the whole point of the lexicon is that it is the thing
 *   allowed to decide two names are the same food.
 * - The merge key is dimension plus, for discrete units only, the unit itself
 *   (plan D5, and see `units.ts` on why `mergeUnit` exists).
 *
 * A contribution with no parseable quantity ("salt, to taste") joins an existing
 * row as a source without moving the total, which is why `quantityBase` is
 * nullable all the way through.
 */

import type { Aisle } from "./aisles";
import { type FoodMatch, type Lexicon, categorizeWith } from "./categorize";
import { type ParseOptions, type ParsedIngredient, parseIngredientLine } from "./parse";
import { type UnitDim, renderQuantity, resolveUnit, unitLabel } from "./units";

/** One recipe line on its way into a row. */
export interface Contribution {
  /** The recipe this came from, or `null` for a manually typed item. */
  recipeId: string | null;
  /** The plan entry this came from, when the add was a plan week. */
  planEntryId?: string | null;
  /** Applied to the parsed quantity before merging (plan §5.3). */
  scale: number;
  /** The ingredient line, verbatim. Snapshotted onto `grocery_item_source`. */
  rawText: string;
  /** This contribution's share of the total, in base units. */
  quantityBase: number | null;
}

/** A consolidated row: one food, one merge key, one or more contributions. */
export interface MergedRow {
  /** Open Food Facts id, `null` when unmatched. */
  foodSlug: string | null;
  /** Normalized identity, and the merge key when `foodSlug` is `null`. */
  nameNorm: string;
  /** What the user sees. Editable in the preview and on the list. */
  displayName: string;
  aisle: Aisle;
  unitDim: UnitDim;
  /** Canonical unit id of the first contribution — anchors how totals render. */
  unit: string | null;
  /** Pins a discrete row to one unit; `null` when the unit converts freely. */
  mergeUnit: string | null;
  /** Total in base units. `null` when no contribution carried a quantity. */
  quantityBase: number | null;
  /** Upper bound, when at least one contribution gave a range. */
  quantityMaxBase: number | null;
  /** Rendered total: `1 lb 8 oz`, `2½ cups`, `3 cloves`. `null` when unknown. */
  quantityDisplay: string | null;
  /** Shown in the preview but unchecked by default (plan D9). */
  isStaple: boolean;
  /** Never shopped for — the preview drops these. */
  isIgnored: boolean;
  /** Every line that fed this row, in the order they arrived. */
  sources: Contribution[];
}

/** One recipe's worth of input. */
export interface RecipeLines {
  recipeId: string | null;
  planEntryId?: string | null;
  /** Applied to every line from this recipe (plan D4). */
  scale?: number;
  lines: readonly string[];
}

/**
 * Identity plus merge key. Two contributions land in the same row iff this
 * string matches. The parts are joined with an ASCII unit separator, written as
 * an escape so no literal control byte lands in this file, because no food name
 * can contain one and therefore none can forge a collision.
 */
export const KEY_SEP = "\u001f";

function rowKey(identity: string, dim: UnitDim, mergeUnit: string | null): string {
  return `${identity}${KEY_SEP}${dim}${KEY_SEP}${mergeUnit ?? ""}`;
}

/**
 * Parse, categorize and consolidate a set of recipes into rows.
 *
 * Output order is stable and meaningful: rows come back in the order their first
 * contribution was seen, so the preview reads down the first recipe the way the
 * recipe reads. Aisle grouping is the route's job, not this module's.
 */
export function mergeRecipeLines(lexicon: Lexicon, recipes: readonly RecipeLines[], options: ParseOptions = {}): MergedRow[] {
  const rows = new Map<string, MergedRow>();

  for (const recipe of recipes) {
    const scale = recipe.scale ?? options.scale ?? 1;

    for (const line of recipe.lines) {
      const parsed = parseIngredientLine(line, { scale });
      if (parsed.isGroupHeader || !parsed.name) continue;

      addContribution(rows, lexicon, parsed, {
        recipeId: recipe.recipeId,
        planEntryId: recipe.planEntryId ?? null,
        scale,
        rawText: line,
        quantityBase: parsed.quantityBase,
      });
    }
  }

  return [...rows.values()];
}

/** Parse and categorize a single manually typed item (plan §7, no preview). */
export function mergeManualItem(lexicon: Lexicon, text: string): MergedRow | null {
  const parsed = parseIngredientLine(text);
  if (!parsed.name) return null;

  const rows = new Map<string, MergedRow>();
  addContribution(rows, lexicon, parsed, {
    recipeId: null,
    planEntryId: null,
    scale: 1,
    rawText: text,
    quantityBase: parsed.quantityBase,
  });

  const [row] = [...rows.values()];
  if (!row) return null;
  // A manual item is always honoured: typing "water" is a deliberate act, even
  // though the same word from a recipe is dropped (plan §4.2 / food-staples.ts).
  return { ...row, isIgnored: false };
}

function addContribution(rows: Map<string, MergedRow>, lexicon: Lexicon, parsed: ParsedIngredient, contribution: Contribution): void {
  const match = categorizeWith(lexicon, parsed.name);
  const identity = match.foodSlug ?? match.nameNorm;
  const key = rowKey(identity, parsed.unitDim, parsed.mergeUnit);

  // A contribution with no quantity has no unit either, so its merge key would
  // be a bare count and it would sit in its own row next to the food it belongs
  // to — "2 tsp salt" and a second, empty "salt". Plan §5.2 says it "joins an
  // existing row as a source without changing the total", so identity alone is
  // enough to find that row when there is nothing to add.
  const existingAnyUnit = parsed.quantityBase == null ? findByIdentity(rows, identity) : undefined;
  if (existingAnyUnit) {
    existingAnyUnit.sources.push(contribution);
    return;
  }

  const existing = rows.get(key);
  if (!existing) {
    const quantityMaxBase = maxBase(parsed);
    rows.set(key, {
      foodSlug: match.foodSlug,
      nameNorm: match.nameNorm,
      // See `displayNameFor`.
      displayName: displayNameFor(lexicon, match, parsed.name),
      aisle: match.aisle,
      unitDim: parsed.unitDim,
      unit: parsed.unit,
      mergeUnit: parsed.mergeUnit,
      quantityBase: parsed.quantityBase,
      quantityMaxBase,
      quantityDisplay: render(parsed.quantityBase, quantityMaxBase, parsed.unitDim, parsed.unit),
      isStaple: match.isStaple,
      isIgnored: match.isIgnored,
      sources: [contribution],
    });
    return;
  }

  existing.sources.push(contribution);

  // A quantity-less contribution joins as a source and changes nothing else.
  if (parsed.quantityBase == null) return;

  const contributedMax = maxBase(parsed);
  // Ranges keep both endpoints: a row that saw "2 to 3 cups" and "1 cup" is
  // 3-to-4 cups, so the upper bound tracks the upper reading of every line.
  //
  // The fallbacks read the totals BEFORE this contribution is added, and the
  // whole thing stays null until some line actually gives a range — otherwise
  // every ordinary row grows a phantom upper bound and reads "750 g – 1 kg".
  existing.quantityMaxBase =
    existing.quantityMaxBase == null && contributedMax == null ? null : (existing.quantityMaxBase ?? existing.quantityBase ?? 0) + (contributedMax ?? parsed.quantityBase);

  existing.quantityBase = (existing.quantityBase ?? 0) + parsed.quantityBase;
  // The unit anchor stays whatever the first contribution used, so a list built
  // from pounds keeps reading in pounds.
  existing.unit ??= parsed.unit;
  existing.quantityDisplay = render(existing.quantityBase, existing.quantityMaxBase, existing.unitDim, existing.unit);
}

/** First row for this food, whatever unit it landed in. See the caller. */
function findByIdentity(rows: Map<string, MergedRow>, identity: string): MergedRow | undefined {
  for (const [key, row] of rows) {
    if (key.startsWith(`${identity}${KEY_SEP}`)) return row;
  }
  return undefined;
}

function maxBase(parsed: ParsedIngredient): number | null {
  if (parsed.quantityMax == null) return null;
  const unit = resolveUnit(parsed.unit);
  return parsed.quantityMax * (unit.factor ?? 1);
}

/**
 * What the row says.
 *
 * The lexicon's canonical name only wins when the line matched it **outright** —
 * an exact or singularized hit, which is how five spellings of "scallion"
 * converge on one row that reads one way.
 *
 * The fallback steps are a different story. Left-trim and span search find a
 * food by throwing words away, and those words were often the useful ones:
 * "egg noodles" resolves through `en:noodle` and "marinara sauce" through
 * `en:sauce`, so preferring the canonical name puts `noodle` and `sauce` on a
 * shopping list and expects you to remember which. The match is still what
 * decides merging and the aisle; it just does not get to rename the line.
 */
function displayNameFor(lexicon: Lexicon, match: FoodMatch, fallback: string): string {
  if (match.via !== "exact" && match.via !== "singular") return foodSegment(lexicon, match, fallback);
  return (match.foodSlug ? lexicon.foods[match.foodSlug]?.n : undefined) ?? foodSegment(lexicon, match, fallback);
}

/**
 * The comma-separated segment of the name that still names the same food.
 *
 * `parse.ts` strips the prep clauses it recognises, but recipes write things no
 * word list can enumerate — "mushrooms, stems discarded, caps thickly sliced".
 * Printing all of that on a list you read one-handed in a store is noise.
 *
 * Taking the FIRST segment is the obvious rule and it is wrong: recipes also
 * comma-separate *leading* modifiers, so "boneless, skinless chicken breasts"
 * would render as "boneless". Asking which segment still resolves to the food
 * we already matched picks the right one either way — "mushrooms" from the
 * first case, "skinless chicken breasts" from the second — and falls back to
 * the whole name when no single segment carries it.
 *
 * Display only. Identity, aisle and merging all use the full name, and the
 * verbatim line is snapshotted on the source row regardless.
 */
function foodSegment(lexicon: Lexicon, match: FoodMatch, name: string): string {
  if (!match.foodSlug || !name.includes(",")) return name;

  for (const raw of name.split(",")) {
    const segment = raw.trim();
    if (!segment) continue;
    if (categorizeWith(lexicon, segment).foodSlug === match.foodSlug) return segment;
  }
  return name;
}

/**
 * Render a total, or a range when the two endpoints actually differ. The
 * equality guard matters: every non-range row has `quantityMaxBase` equal to
 * `quantityBase`, and printing "2 – 2 cups" would be absurd.
 */
export function render(base: number | null, maxBase: number | null, dim: UnitDim, unit: string | null): string | null {
  if (base == null) return null;
  const low = renderQuantity(base, dim, unit);
  if (maxBase == null || Math.abs(maxBase - base) < 1e-9) return low;
  return `${low} – ${renderQuantity(maxBase, dim, unit)}`;
}

/** Re-render a row after an inline edit in the preview or on the list. */
export function renderRowQuantity(quantity: number | null, unit: string | null): string | null {
  if (quantity == null) return null;
  const resolved = resolveUnit(unit);
  const label = unitLabel(resolved.id, quantity);
  return label ? `${quantity} ${label}` : String(quantity);
}
