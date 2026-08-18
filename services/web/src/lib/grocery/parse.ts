/**
 * Parse a free-text ingredient line into something addable to a list (plan §5.1).
 *
 * `recipe_ingredient` is `(recipe_id, ordinal, text)` and there is no structured
 * quantity anywhere in the schema, so every line arrives as prose: "2 cloves
 * garlic, finely minced", "Kosher salt, to taste", "1 (14.5 oz) can diced
 * tomatoes". This module turns that into `{ quantity, unit, name, note }`
 * **without touching the recipe schema** (plan D2).
 *
 * [`parse-ingredient`](https://github.com/jakeboone02/parse-ingredient) (MIT)
 * does the numeric grammar — mixed numbers, vulgar fractions, ranges, group
 * headers — and Buttery's own cleanup does the rest, because the library is
 * built to read a line, not to shop from one. What it leaves behind is prep
 * instruction glued to the food: the description for the line above comes back
 * as `garlic, finely minced`, and a list that says that is a list nobody reads.
 *
 * Pure and dependency-free apart from that one parser: no DB, no DOM, no
 * lexicon. Categorization is a separate pass in `categorize.ts`.
 */

import { parseIngredient } from "parse-ingredient";
import { type ResolvedUnit, type UnitDim, resolveUnit, toBaseQuantity } from "./units";

export interface ParsedIngredient {
  /** Lower bound of the quantity, already scaled. `null` when unparseable. */
  quantity: number | null;
  /** Upper bound when the line gave a range ("2 to 3 cups"), else `null`. */
  quantityMax: number | null;
  /** Canonical unit id, e.g. `cup`, `lb`, `clove`. `null` for a bare count. */
  unit: string | null;
  /** Merge dimension (plan D5). */
  unitDim: UnitDim;
  /** The unit a discrete row is pinned to; `null` when the unit converts. */
  mergeUnit: string | null;
  /** The food, cleaned of prep clauses and parentheticals. */
  name: string;
  /** What was stripped off the name and is worth keeping — "finely minced". */
  note: string | null;
  /** `quantity` expressed in the dimension's base unit. `null` if no quantity. */
  quantityBase: number | null;
  /** The line as written, before any of this. Snapshotted onto the source row. */
  raw: string;
  /** A section heading ("For the sauce:"), not an ingredient. */
  isGroupHeader: boolean;
}

/**
 * Prep words that may lead a description and are **never** part of a food's
 * identity. This list is deliberately short.
 *
 * The tempting version of this regex also strips `ground`, `fresh`, `large` and
 * `boneless`, and it is wrong: `ground beef` is a different thing to buy than
 * `beef`, and throwing the modifier away at parse time merges them for good.
 * Narrowing a name down to its head noun is `categorize.ts`'s left-trim pass
 * (plan §4.3 step 3), which does it only to *find* a match and leaves the name
 * itself intact. Parse strips adverbs and states-of-preparation; matching
 * handles the rest.
 */
const LEADING_PREP = /^(?:freshly|finely|coarsely|roughly|thinly|thickly|lightly|well|very)\b[,\s]+|^(?:melted|softened|beaten|divided|packed|drained|rinsed|thawed)\b[,\s]+/iu;

/**
 * Size words `parse-ingredient` would otherwise read as units of measure. "3
 * large eggs" is three eggs, not three larges, and letting `large` become a
 * discrete unit would stop it merging with "2 eggs" from the next recipe.
 */
const SIZE_WORDS = ["small", "medium", "large", "extra-large", "extra large", "x-large", "jumbo", "big", "little"];

/** A trailing prep clause after a comma: "garlic, finely minced". */
const TRAILING_PREP =
  /,\s*(?:(?:freshly|finely|coarsely|roughly|thinly|thickly|lightly|well|very)\s+)?(?:chopped|minced|diced|sliced|grated|shredded|crushed|ground|melted|softened|beaten|peeled|seeded|stemmed|trimmed|rinsed|drained|cubed|julienned|quartered|halved|divided|plus more.*|or more.*|to taste|for serving|for garnish|optional|room temperature|at room temperature|thawed|packed|lightly packed|firmly packed)\b.*$/iu;

/**
 * A section heading: no quantity and a trailing colon. `parse-ingredient` only
 * recognises headings that open with one of its configured words ("For …"), so
 * "Sauce:" and "To serve:" reach us looking like ingredients. Shape catches what
 * a vocabulary cannot.
 */
const HEADING = /:\s*$/u;

/** "to taste", "as needed" — a line that is real but has no quantity to add. */
const QTY_LESS = /\b(?:to taste|as needed|as required|for serving|for garnish|for dusting)\b/iu;

/** Parentheticals: "(14.5 oz)", "(about 2 cups)". Dropped from the name. */
const PARENTHETICAL = /\s*\([^)]*\)\s*/gu;

/** Leading articles left behind once a quantity is lifted off. */
const LEADING_ARTICLE = /^(?:an?|the|some)\s+/iu;

/** Trailing junk after the cleanup passes. */
const TRAILING_PUNCT = /[\s,;:.\-–—]+$/u;

export interface ParseOptions {
  /** Multiply every parsed quantity by this before returning it (plan §5.3). */
  scale?: number;
}

/**
 * Parse one ingredient line.
 *
 * Never throws and never returns `null`: a line this cannot make sense of comes
 * back with `quantity: null` and the whole cleaned line as `name`, which still
 * consolidates by name and still lands on the list. Dropping a line silently
 * would be the one unrecoverable failure here — you find out in the store.
 */
export function parseIngredientLine(line: string, options: ParseOptions = {}): ParsedIngredient {
  const scale = options.scale ?? 1;
  const raw = line;

  // Parentheticals come off BEFORE the library sees the line. Left in, the
  // "(14.5 oz)" in "1 (14.5 oz) can diced tomatoes" sits between the quantity
  // and the unit and the parser never finds `can` at all — the line comes back
  // as one unitless thing called "can diced tomatoes".
  const notes: string[] = [];
  const withoutParens = line.replace(PARENTHETICAL, (match) => {
    const inner = match.trim().slice(1, -1).trim();
    if (inner) notes.push(inner);
    return " ";
  });

  const [parsed] = parseIngredient(withoutParens, { allowLeadingOf: false, ignoreUOMs: SIZE_WORDS });

  if (!parsed) {
    return {
      quantity: null,
      quantityMax: null,
      unit: null,
      unitDim: "count",
      mergeUnit: null,
      name: cleanName(line),
      note: null,
      quantityBase: null,
      raw,
      isGroupHeader: false,
    };
  }

  if (parsed.isGroupHeader || (parsed.quantity == null && HEADING.test(line))) {
    return {
      quantity: null,
      quantityMax: null,
      unit: null,
      unitDim: "count",
      mergeUnit: null,
      name: parsed.description.trim(),
      note: null,
      quantityBase: null,
      raw,
      isGroupHeader: true,
    };
  }

  const unit: ResolvedUnit = resolveUnit(parsed.unitOfMeasure);
  const { name, note } = splitNameAndNote(parsed.description, notes);

  // A "to taste" line may still have parsed a quantity off something incidental;
  // treating it as quantity-less is what keeps it from inventing a total.
  const qtyLess = QTY_LESS.test(raw);
  const quantity = qtyLess || parsed.quantity == null ? null : parsed.quantity * scale;
  const quantityMax = qtyLess || parsed.quantity2 == null ? null : parsed.quantity2 * scale;

  return {
    quantity,
    quantityMax,
    unit: unit.id,
    unitDim: unit.dim,
    mergeUnit: unit.mergeUnit,
    name,
    note,
    quantityBase: toBaseQuantity(quantity, unit),
    raw,
    isGroupHeader: false,
  };
}

/** Parse a whole ingredient list, dropping group headers. */
export function parseIngredientLines(lines: readonly string[], options: ParseOptions = {}): ParsedIngredient[] {
  return lines.map((line) => parseIngredientLine(line, options)).filter((parsed) => !parsed.isGroupHeader && parsed.name.length > 0);
}

/**
 * Split a description into the food and the prep note.
 *
 * The note is kept rather than thrown away because it is often the only thing
 * distinguishing two otherwise identical lines, and because "1 lb chicken
 * breast (boneless, skinless)" is a genuinely useful thing to read in a store
 * even though it must not be part of the name that decides merging.
 */
function splitNameAndNote(description: string, carried: readonly string[]): { name: string; note: string | null } {
  const notes = [...carried];
  let text = description;

  const trailing = TRAILING_PREP.exec(text);
  if (trailing) {
    notes.push(trailing[0].replace(/^,\s*/u, "").trim());
    text = text.slice(0, trailing.index);
  }

  // Leading prep runs one word at a time: "finely chopped fresh parsley" has to
  // shed all three before the noun is reachable.
  let previous = "";
  while (text !== previous) {
    previous = text;
    const leading = LEADING_PREP.exec(text);
    if (leading) {
      notes.push(leading[0].trim());
      text = text.slice(leading[0].length);
    }
  }

  return { name: cleanName(text), note: notes.length ? notes.join(", ") : null };
}

/** Final tidy: collapse whitespace, drop articles and trailing punctuation. */
function cleanName(text: string): string {
  return text.replace(PARENTHETICAL, " ").replace(/\s+/gu, " ").trim().replace(LEADING_ARTICLE, "").replace(TRAILING_PUNCT, "").trim();
}
