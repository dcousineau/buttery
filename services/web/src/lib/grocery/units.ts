/**
 * Units for the grocery list: resolve a written unit, convert to a base unit,
 * sum, and render the total back out (plan §5.1).
 *
 * Pure and dependency-free — no DB, no DOM, no lexicon — so the identical module
 * runs inside a server function and inside a browser that has gone offline.
 *
 * **This is not `src/lib/recipe-scale.ts` and must not replace it.** That module
 * serves cook mode and the detail pane, where a lossy parse of a single line is
 * the right trade; its `MEASURE_UNITS` set and `TO_ML`/`TO_G` tables are the
 * reference this table was seeded from, nothing more. The job here is different:
 * quantities from different recipes have to be *added together*, which means
 * knowing not just what a unit is called but whether it can be converted at all.
 *
 * ## The three dimensions, and the fourth thing
 *
 * `unitDim` is `volume | mass | count`, and plan D5 forbids merging across them:
 * `1 lb chicken breast` and `2 chicken breasts` stay two rows because no honest
 * factor turns pounds into birds.
 *
 * Inside a dimension there is a second, subtler split. `cup` and `tbsp` are both
 * volume and both convert to millilitres, so `1 cup` + `2 tbsp` is a legitimate
 * sum. `clove` and `can` are countable but convert to nothing — two cloves of
 * garlic and one can of garlic have no common total. Units like that are
 * **discrete**, and {@link resolveUnit} reports them through `mergeUnit`, which
 * pins a row to that one unit. A convertible unit has `mergeUnit === null` and
 * merges freely with anything else in its dimension.
 *
 * That extra field is the reason `grocery_item` carries a `merge_unit` column
 * the plan's §6 sketch did not have. Without it the plan's own partial unique
 * index would force `2 cans tomatoes` and `3 tomatoes` — both `count` — into one
 * row reading `5`. It only ever splits rows D5 already wanted split; nothing that
 * used to merge stops merging.
 */

export type UnitDim = "volume" | "mass" | "count";

/** Base unit per dimension: millilitres, grams, and bare things. */
export const BASE_UNIT: Record<UnitDim, string> = { volume: "ml", mass: "g", count: "" };

export interface ResolvedUnit {
  /** Merge dimension. */
  dim: UnitDim;
  /** Canonical unit id, e.g. `cup`, `pound`, `clove`. `null` for a bare count. */
  id: string | null;
  /** Multiplier to the dimension's base unit. `null` when the unit is discrete. */
  factor: number | null;
  /**
   * The unit this row is pinned to, or `null` when the unit converts freely.
   * Two contributions may only merge when their `mergeUnit`s are equal.
   */
  mergeUnit: string | null;
  /** True when the unit reads metric, which decides how a total renders back. */
  metric: boolean;
}

interface UnitDef {
  dim: UnitDim;
  /** To base unit. Omitted for discrete units, which cannot be converted. */
  factor?: number;
  metric?: boolean;
  /** Singular and plural display forms. */
  one: string;
  many: string;
  /** Everything that should resolve to this unit, lowercased. */
  names: string[];
}

/**
 * Conversion factors are US customary, matching the recipes Buttery actually
 * holds. `parse-ingredient` carries imperial and metric variants of the same
 * units; picking one system per unit keeps totals reproducible, and a recipe
 * that says "cup" in a country where that means 250ml is off by 5%, which is
 * well inside the error of "a cup of flour" anyway.
 */
const UNIT_DEFS: UnitDef[] = [
  // --- volume, convertible ------------------------------------------------
  { dim: "volume", factor: 1, metric: true, one: "ml", many: "ml", names: ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"] },
  { dim: "volume", factor: 1000, metric: true, one: "l", many: "l", names: ["l", "liter", "liters", "litre", "litres"] },
  { dim: "volume", factor: 4.928922, one: "tsp", many: "tsp", names: ["tsp", "tsps", "tsp.", "t", "teaspoon", "teaspoons", "teaspoonful"] },
  { dim: "volume", factor: 14.786765, one: "tbsp", many: "tbsp", names: ["tbsp", "tbsps", "tbsp.", "tbs", "tb", "tablespoon", "tablespoons", "tablespoonful"] },
  { dim: "volume", factor: 29.5735, one: "fl oz", many: "fl oz", names: ["fl oz", "floz", "fl. oz.", "fluid ounce", "fluid ounces"] },
  { dim: "volume", factor: 236.58824, one: "cup", many: "cups", names: ["cup", "cups", "c", "c."] },
  { dim: "volume", factor: 473.176, one: "pint", many: "pints", names: ["pint", "pints", "pt", "pts"] },
  { dim: "volume", factor: 946.353, one: "quart", many: "quarts", names: ["quart", "quarts", "qt", "qts"] },
  { dim: "volume", factor: 3785.41, one: "gallon", many: "gallons", names: ["gallon", "gallons", "gal"] },

  // --- mass, convertible --------------------------------------------------
  { dim: "mass", factor: 1, metric: true, one: "g", many: "g", names: ["g", "g.", "gram", "grams", "gramme", "grammes"] },
  { dim: "mass", factor: 1000, metric: true, one: "kg", many: "kg", names: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"] },
  { dim: "mass", factor: 28.349523, one: "oz", many: "oz", names: ["oz", "oz.", "ounce", "ounces"] },
  { dim: "mass", factor: 453.59237, one: "lb", many: "lb", names: ["lb", "lb.", "lbs", "lbs.", "pound", "pounds"] },

  // --- discrete: countable, but convertible to nothing --------------------
  { dim: "count", one: "clove", many: "cloves", names: ["clove", "cloves"] },
  { dim: "count", one: "can", many: "cans", names: ["can", "cans"] },
  { dim: "count", one: "jar", many: "jars", names: ["jar", "jars"] },
  { dim: "count", one: "package", many: "packages", names: ["package", "packages", "pkg", "pkgs", "packet", "packets"] },
  { dim: "count", one: "stick", many: "sticks", names: ["stick", "sticks"] },
  { dim: "count", one: "slice", many: "slices", names: ["slice", "slices"] },
  { dim: "count", one: "sprig", many: "sprigs", names: ["sprig", "sprigs"] },
  { dim: "count", one: "stalk", many: "stalks", names: ["stalk", "stalks"] },
  { dim: "count", one: "head", many: "heads", names: ["head", "heads"] },
  { dim: "count", one: "bunch", many: "bunches", names: ["bunch", "bunches"] },
  { dim: "count", one: "pinch", many: "pinches", names: ["pinch", "pinches"] },
  { dim: "count", one: "dash", many: "dashes", names: ["dash", "dashes"] },
  { dim: "count", one: "handful", many: "handfuls", names: ["handful", "handfuls"] },
  { dim: "count", one: "sheet", many: "sheets", names: ["sheet", "sheets"] },
  { dim: "count", one: "bottle", many: "bottles", names: ["bottle", "bottles"] },
  { dim: "count", one: "loaf", many: "loaves", names: ["loaf", "loaves"] },
  { dim: "count", one: "ear", many: "ears", names: ["ear", "ears"] },
  { dim: "count", one: "fillet", many: "fillets", names: ["fillet", "fillets", "filet", "filets"] },
];

const BY_NAME = new Map<string, UnitDef>();
for (const def of UNIT_DEFS) for (const name of def.names) BY_NAME.set(name, def);

const BY_ID = new Map<string, UnitDef>();
for (const def of UNIT_DEFS) BY_ID.set(def.one, def);

/** A bare count — no unit was written at all. `2 eggs`. */
const BARE: ResolvedUnit = { dim: "count", id: null, factor: 1, mergeUnit: null, metric: false };

function normalizeUnitText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.\s]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Resolve a written unit. An unrecognised word is treated as a discrete count
 * unit rather than discarded: "2 rashers bacon" should stay two rashers and
 * refuse to merge with "100 g bacon", which is exactly what pinning `mergeUnit`
 * to `rasher` achieves.
 */
export function resolveUnit(raw: string | null | undefined): ResolvedUnit {
  if (raw == null) return BARE;
  const text = normalizeUnitText(raw);
  if (!text) return BARE;

  const def = BY_NAME.get(text) ?? BY_NAME.get(text.replace(/\s/g, ""));
  if (!def) {
    // Unknown word: discrete, pinned to itself, never converted.
    return { dim: "count", id: text, factor: null, mergeUnit: text, metric: false };
  }
  return {
    dim: def.dim,
    id: def.one,
    factor: def.factor ?? null,
    mergeUnit: def.factor == null ? def.one : null,
    metric: def.metric ?? false,
  };
}

/**
 * A contribution in base units, or `null` when the line carried no usable
 * quantity ("salt to taste"). A `null` contribution still joins a row as a
 * source — it just does not move the total (plan §5.2).
 */
export function toBaseQuantity(quantity: number | null, unit: ResolvedUnit): number | null {
  if (quantity == null) return null;
  // A discrete unit has no factor, but the count itself still adds up: three
  // cloves plus two cloves is five cloves.
  return quantity * (unit.factor ?? 1);
}

/** Two contributions may be summed only when both of these agree (plan D5). */
export function mergeKey(unit: ResolvedUnit): string {
  return `${unit.dim} ${unit.mergeUnit ?? ""}`;
}

// --- rendering ------------------------------------------------------------

/** Eighth index → vulgar fraction, for US display. Mirrors `recipe-scale.ts`. */
const EIGHTHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"] as const;

/**
 * US-style number: whole part plus the nearest eighth as a vulgar fraction.
 * `2.5` → `2½`, `0.75` → `¾`, `3` → `3`.
 */
export function formatUS(value: number): string {
  const rounded = Math.round(value * 8) / 8;
  const whole = Math.floor(rounded);
  const eighths = Math.round((rounded - whole) * 8);
  const fraction = EIGHTHS[eighths] ?? "";
  if (!fraction) return String(whole);
  return whole === 0 ? fraction : `${whole}${fraction}`;
}

/** Metric-style number: at most one decimal, no trailing zero. */
function formatMetric(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Plain number for counts: `2`, `1.5`. */
function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : formatUS(value);
}

const LB = 453.59237;
const OZ = 28.349523;
const CUP = 236.58824;
const TBSP = 14.786765;
const TSP = 4.928922;

/**
 * Render a base-unit total back into something a person reads in a store.
 *
 * `anchorUnitId` is the unit of the row's first contribution and decides the
 * system: a list built from `1 lb` + `8 oz` reads `1 lb 8 oz`, while one built
 * from `500 g` + `250 g` reads `750 g` rather than being converted into pounds
 * nobody asked for.
 */
export function renderQuantity(base: number, dim: UnitDim, anchorUnitId: string | null): string {
  const anchor = anchorUnitId ? BY_ID.get(anchorUnitId) : undefined;
  const metric = anchor?.metric ?? false;

  if (dim === "count") {
    const count = formatCount(base);
    if (!anchor) return count;
    return `${count} ${base === 1 ? anchor.one : anchor.many}`;
  }

  if (dim === "mass") {
    if (metric) return base >= 1000 ? `${formatMetric(base / 1000)} kg` : `${formatMetric(base)} g`;
    if (base >= LB) {
      const pounds = Math.floor(base / LB);
      const remainder = base - pounds * LB;
      // Under a tenth of an ounce is rounding noise from the conversion, not a
      // quantity anybody weighed out.
      const ounces = Math.round((remainder / OZ) * 10) / 10;
      if (ounces < 0.1) return `${pounds} lb`;
      if (ounces >= 16) return `${pounds + 1} lb`;
      return `${pounds} lb ${formatCount(ounces)} oz`;
    }
    return `${formatCount(Math.round((base / OZ) * 10) / 10)} oz`;
  }

  // volume
  if (metric) return base >= 1000 ? `${formatMetric(base / 1000)} l` : `${formatMetric(base)} ml`;
  if (base >= CUP / 4) return `${formatUS(base / CUP)} ${base >= CUP * 1.5 ? "cups" : "cup"}`;
  if (base >= TBSP) return `${formatUS(base / TBSP)} tbsp`;
  return `${formatUS(base / TSP)} tsp`;
}

/** Display form of a unit id, for echoing a single contribution back. */
export function unitLabel(unitId: string | null, quantity: number): string | null {
  if (!unitId) return null;
  const def = BY_ID.get(unitId);
  if (!def) return unitId;
  return quantity === 1 ? def.one : def.many;
}
