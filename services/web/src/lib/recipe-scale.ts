/**
 * Ingredient scale & convert — a pure, dependency-free port of the recipes-index
 * prototype's rules (design handoff §"Ingredient scaling & conversion rules",
 * plan `docs/plans/03-household-recipe-collection.md` §10). No React; consumed by
 * the detail pane and unit-tested in `recipe-scale.test.ts`.
 *
 * The parse is deliberately lossy — string quantities, not structured data. Known
 * gaps, documented not fixed: pluralization ("2 can coconut milk"), and
 * volume→mass for dry goods (flour, cornmeal). The real fix is structured
 * quantities on the recipe record (a future project).
 */

/** Unicode vulgar fractions we accept, mapped to their decimal value. */
const FRACTIONS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };

/** Eighth index → unicode fraction glyph, for US display formatting. */
const EIGHTHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"] as const;

/** US volume/weight unit → metric factor. */
const TO_ML: Record<string, number> = { cup: 236.6, cups: 236.6, tbsp: 14.8, tsp: 4.9 };
const TO_G: Record<string, number> = { lb: 453.6, oz: 28.35 };

/**
 * A leading quantity, an optional unit token, and the trailing remainder.
 *   `(qty)(unit?)(rest)` — qty is one of: `2`, `1.5`, `1/2`, `½`, `1¼` / `1 ½`.
 * A line with no parseable leading quantity does not match (passes through).
 */
const LINE_RE = /^(\d+\s*[¼½¾⅓⅔⅛]|\d+\/\d+|[¼½¾⅓⅔⅛]|\d+(?:\.\d+)?)\s*([a-zA-Z]+)?(.*)$/;

/** Metric rounding: nearest 5, or nearest 10 above 100. */
function round5(n: number): number {
  return n >= 100 ? Math.round(n / 10) * 10 : Math.round(n / 5) * 5;
}

/**
 * US display: values ≥10 round to whole numbers; below 10, round to the nearest
 * eighth and render with unicode fractions (`1½`, `¾`, `2⅛`).
 */
export function formatUS(n: number): string {
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n);
  const eighth = Math.round((n - whole) * 8);
  if (eighth === 8) return String(whole + 1);
  const glyph = EIGHTHS[eighth];
  if (!glyph) return String(whole || 0);
  return (whole ? whole : "") + glyph;
}

/** Parse a raw quantity token (`"1/2"`, `"1½"`, `"2"`, `"1.5"`) to a number. */
function parseQty(rawQty: string): number {
  if (rawQty.includes("/")) {
    const [a, b] = rawQty.split("/");
    return Number(a) / Number(b);
  }
  const fracMatch = rawQty.match(/[¼½¾⅓⅔⅛]/);
  const whole = Number(rawQty.replace(/[¼½¾⅓⅔⅛]/g, "").trim() || 0);
  return whole + (fracMatch ? FRACTIONS[fracMatch[0]] : 0);
}

/**
 * Scale (and optionally convert to metric) a single ingredient line.
 *
 * - No leading quantity ⇒ the line passes through unchanged ("Lemon, to finish").
 * - The quantity is multiplied by `factor`.
 * - `metric = true`: cup/tbsp/tsp → ml, lb/oz → g (rounded per {@link round5});
 *   already-metric g/ml pass through rounded.
 * - `metric = false` (US): g → oz, ml → cups; every other unit and bare counts
 *   scale and re-emit verbatim ({@link formatUS} formatting).
 */
export function scaleIngredient(line: string, factor: number, metric: boolean): string {
  const m = line.match(LINE_RE);
  if (!m) return line;
  const [, rawQty, rawUnit, rest] = m;

  const qty = parseQty(rawQty) * factor;
  const unit = (rawUnit || "").toLowerCase();
  // Collapse the gap the unit/quantity left to a single space so tails line up.
  const tail = (rest || "").replace(/^\s+/, " ");

  if (metric) {
    if (TO_ML[unit] !== undefined) return `${round5(qty * TO_ML[unit])} ml${tail}`;
    if (TO_G[unit] !== undefined) return `${round5(qty * TO_G[unit])} g${tail}`;
    if (unit === "g" || unit === "ml") return `${round5(qty)} ${unit}${tail}`;
  } else {
    if (unit === "g") return `${formatUS(qty / 28.35)} oz${tail}`;
    if (unit === "ml") return `${formatUS(qty / 236.6)} cups${tail}`;
  }

  return `${formatUS(qty)}${rawUnit ? ` ${rawUnit}` : ""}${tail}`;
}

/** Convenience: scale an array of ingredient lines. */
export function scaleIngredients(lines: string[], factor: number, metric: boolean): string[] {
  return lines.map((line) => scaleIngredient(line, factor, metric));
}

/**
 * Parse the leading integer of a free-text `recipe_yield` ("8 servings" → 8).
 * Returns null when no leading integer is present (caller shows the raw yield and
 * does not scale the count — plan §5.3 / §9.3).
 */
export function parseServes(recipeYield: string | null | undefined): number | null {
  if (!recipeYield) return null;
  const m = recipeYield.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
