/**
 * The 14 curated grocery aisles (plan D7).
 *
 * Fixed enum, fixed order, no per-household reordering and no store layouts.
 * The order is perimeter-first — the way most stores are laid out and the way
 * most people actually walk one — with `other` pinned last so unmatched lines
 * never interrupt a shopping run.
 *
 * This module is pure and dependency-free on purpose: it is imported by the
 * build-time lexicon generator (`scripts/build-food-lexicon.ts`), by server
 * functions, and by the browser.
 */

export const AISLES = [
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery",
  "deli",
  "frozen",
  "canned_jarred",
  "dry_goods",
  "pantry",
  "spices",
  "baking",
  "beverages",
  "snacks",
  "other",
] as const;

export type Aisle = (typeof AISLES)[number];

/** Fallback for anything the lexicon cannot place. Always renders last. */
export const DEFAULT_AISLE: Aisle = "other";

const AISLE_SET = new Set<string>(AISLES);

export function isAisle(value: string): value is Aisle {
  return AISLE_SET.has(value);
}

/** Coerce an untrusted string (a DB column, a search param) to a known aisle. */
export function toAisle(value: string | null | undefined): Aisle {
  return value != null && isAisle(value) ? value : DEFAULT_AISLE;
}

const AISLE_ORDER = new Map<Aisle, number>(AISLES.map((a, i) => [a, i]));

/** Canonical sort position. Unknown values sort with `other`, at the end. */
export function aisleOrder(aisle: Aisle): number {
  return AISLE_ORDER.get(aisle) ?? AISLES.length - 1;
}

export const AISLE_LABELS: Record<Aisle, string> = {
  produce: "Produce",
  meat_seafood: "Meat & seafood",
  dairy_eggs: "Dairy & eggs",
  bakery: "Bakery",
  deli: "Deli",
  frozen: "Frozen",
  canned_jarred: "Canned & jarred",
  dry_goods: "Dry goods",
  pantry: "Pantry",
  spices: "Spices",
  baking: "Baking",
  beverages: "Beverages",
  snacks: "Snacks",
  other: "Other",
};
