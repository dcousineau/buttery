/**
 * Client-safe helpers for looking at an `exchange.recipe.recipe` record as data
 * rather than as a rendered recipe.
 *
 * Two jobs, and they are different:
 *
 * - `flattenRecord` turns any JSON value into an ordered list of
 *   `path → type → value` rows. That is the "raw schema" view: it shows exactly
 *   what is on the wire, including fields no lexicon we know about declares,
 *   which is the whole reason an operator opens this page.
 *
 * - `COMPARABLE_PATHS` is the *curated* subset that a locally-stored recipe can
 *   also be projected onto (see `server/local-recipes.ts`). It exists so the
 *   detail view can sit the two representations in one table, path by path,
 *   instead of asking a human to eyeball two JSON blobs.
 */

/** One row of the flattened view of a record. */
export interface FlatRow {
  /** Dotted path with array indices, e.g. `embed.images.0.alt`. */
  path: string;
  /** The JSON type at that path — `string`, `integer`, `array`, `null`, … */
  type: string;
  /** The scalar, rendered for display. Containers render as a shape summary. */
  value: string;
  /** Nesting depth, so the UI can indent without re-parsing the path. */
  depth: number;
  /** True for objects and arrays — rows that have children rather than a value. */
  container: boolean;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * Render a scalar the way an operator wants to read it in a table cell: no
 * quotes around strings (they add noise to every row and the `type` column
 * already says it is a string), and containers summarised by size rather than
 * re-serialised.
 */
function renderValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return `{${Object.keys(value).length}}`;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // `undefined`, `symbol`, `function` — impossible in parsed JSON, but this
  // takes any value, and `[object Object]` in a schema view is worse than a
  // type name.
  return `<${typeof value}>`;
}

/**
 * Depth-first flatten of a JSON value into `FlatRow`s, parents before children,
 * array elements in index order and object keys in their **on-the-wire order**
 * — deliberately not sorted. The order keys arrive in is itself information
 * when you are staring at a record that a client wrote.
 */
export function flattenRecord(value: unknown, prefix = "", depth = 0): FlatRow[] {
  const rows: FlatRow[] = [];
  const type = jsonType(value);
  const container = type === "object" || type === "array";

  if (prefix !== "") {
    rows.push({ path: prefix, type, value: renderValue(value), depth, container });
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rows.push(...flattenRecord(item, prefix === "" ? String(index) : `${prefix}.${index}`, depth + 1));
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      rows.push(...flattenRecord(child, prefix === "" ? key : `${prefix}.${key}`, depth + 1));
    }
  }

  return rows;
}

/**
 * A value as display text, with a fallback for absent.
 *
 * Exists because the wire types are honestly `JsonValue` — a column *could*
 * hold an object — and `String(someJsonValue)` on one would print
 * `[object Object]` into the UI. This makes the fallback explicit at every call
 * site instead.
 */
export function asText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Every scalar path in a record, as `path → rendered value`. */
export function scalarPaths(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of flattenRecord(value)) {
    if (!row.container) out[row.path] = row.value;
  }
  return out;
}

/**
 * The fixed fields of `exchange.recipe.recipe`, in the order the lexicon
 * declares them, with the label the comparison table shows.
 *
 * Repeated fields (`ingredients.0`, `embed.images.1.alt`, …) are NOT listed:
 * they are discovered from whichever side actually has them, because the count
 * differing between the two sides is itself one of the things an operator is
 * looking for.
 */
export const COMPARABLE_PATHS: ReadonlyArray<{ path: string; label: string; kind?: "timestamp" }> = [
  { path: "name", label: "Name" },
  { path: "text", label: "Description" },
  { path: "createdAt", label: "Created at", kind: "timestamp" },
  { path: "updatedAt", label: "Updated at", kind: "timestamp" },
  { path: "prepTime", label: "Prep time" },
  { path: "cookTime", label: "Cook time" },
  { path: "totalTime", label: "Total time" },
  { path: "recipeYield", label: "Yield" },
  { path: "recipeCategory", label: "Category" },
  { path: "recipeCuisine", label: "Cuisine" },
  { path: "cookingMethod", label: "Cooking method" },
  { path: "nutrition.calories", label: "Calories" },
  { path: "nutrition.fatContent", label: "Fat" },
  { path: "nutrition.proteinContent", label: "Protein" },
  { path: "nutrition.carbohydrateContent", label: "Carbohydrate" },
];

/** Path prefixes whose members are ordered lists compared element by element. */
const REPEATED_PREFIXES = ["ingredients.", "instructions.", "keywords.", "suitableForDiet.", "embed.images."];

function isRepeated(path: string): boolean {
  return REPEATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** One row of the local-vs-network comparison. */
export interface ComparisonRow {
  path: string;
  label: string;
  local: string | null;
  network: string | null;
  status: ComparisonStatus;
}

/**
 * `absent` is its own state and not a kind of missing: a field neither copy
 * carries is a fact about the schema, while `local-only` / `network-only` are
 * facts about a disagreement. Collapsing them (the first cut of this did, by
 * falling through to `network-only`) labels every empty optional field as a
 * network-side value the local copy is missing, which is exactly backwards.
 */
export type ComparisonStatus = "same" | "differs" | "local-only" | "network-only" | "absent";

/**
 * Two ISO-8601 instants are equal when they name the same moment, whatever
 * their spelling. Postgres hands back a `Date` that re-prints with millisecond
 * precision (`…T10:00:00.000Z`) while the record carries whatever the
 * publishing client wrote (`…T10:00:00Z`), so a byte comparison reports every
 * single published recipe as having a differing `createdAt` — a false positive
 * on the one field an operator is least able to act on.
 *
 * Only applied to paths declared `kind: "timestamp"`. A general "does this
 * parse as a date" test would quietly coerce ingredient text and yields.
 */
function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  // An unparseable value falls back to the literal comparison rather than
  // claiming a match — a malformed timestamp on one side is a finding.
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return left === right;
}

function statusFor(local: string | null, network: string | null, kind?: "timestamp"): ComparisonStatus {
  if (local === null && network === null) return "absent";
  if (local === null) return "network-only";
  if (network === null) return "local-only";
  const equal = kind === "timestamp" ? sameInstant(local, network) : local === network;
  return equal ? "same" : "differs";
}

/**
 * Sit the two projections side by side, path by path.
 *
 * The curated paths come first and always appear, marked `absent` when neither
 * side has a value — "this field exists and both sides are silent" reads very
 * differently from the field being missing from the page. The repeated paths
 * follow, sorted, and are included only when at least one side has them.
 *
 * Nothing here picks a winner. That is the point: the app's read path resolves
 * a single recipe from whichever source it trusts, and this view exists
 * precisely because that resolution hides the disagreement.
 */
export function compareProjections(local: Record<string, string> | null, network: Record<string, string> | null): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  for (const { path, label, kind } of COMPARABLE_PATHS) {
    const localValue = local?.[path] ?? null;
    const networkValue = network?.[path] ?? null;
    rows.push({ path, label, local: localValue, network: networkValue, status: statusFor(localValue, networkValue, kind) });
  }

  const repeated = new Set<string>();
  for (const path of Object.keys(local ?? {})) if (isRepeated(path)) repeated.add(path);
  for (const path of Object.keys(network ?? {})) if (isRepeated(path)) repeated.add(path);

  for (const path of [...repeated].sort(comparePaths)) {
    const localValue = local?.[path] ?? null;
    const networkValue = network?.[path] ?? null;
    rows.push({ path, label: path, local: localValue, network: networkValue, status: statusFor(localValue, networkValue) });
  }

  return rows;
}

/**
 * Sort repeated paths so `ingredients.10` follows `ingredients.9` rather than
 * `ingredients.1` — a plain string sort puts a 10-ingredient recipe's list in
 * an order no cook would recognise.
 */
function comparePaths(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? "";
    const bPart = bParts[i] ?? "";
    if (aPart === bPart) continue;
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    if (Number.isInteger(aNum) && Number.isInteger(bNum)) return aNum - bNum;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}
