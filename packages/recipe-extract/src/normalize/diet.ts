/**
 * schema.org RestrictedDiet → lexicon diet token (`exchange.recipe.defs#diet*`).
 *
 * Only the intersection of schema.org's RestrictedDiet enum and Buttery's diet
 * vocab (the migration seed mirrored in the web app's recipe-vocab) is mapped —
 * anything outside it is dropped here and instead rides along as a keyword. The
 * schema.org enum is a fixed, stable URL set, so hardcoding it is safe and keeps
 * this package independent of the app's vocab module. Accepts either the full
 * URL or the bare enum member ("VeganDiet").
 */

const NSID = "exchange.recipe.defs";

// schema.org member (lowercased) → lexicon diet suffix. Keto/LowCarb/Paleo have
// no schema.org RestrictedDiet member, so imports can't set them (kept manual).
const MEMBER_TO_SUFFIX: Record<string, string> = {
  diabeticdiet: "Diabetic",
  glutenfreediet: "GlutenFree",
  halaldiet: "Halal",
  kosherdiet: "Kosher",
  lowcaloriediet: "LowCalorie",
  lowfatdiet: "LowFat",
  vegandiet: "Vegan",
  vegetariandiet: "Vegetarian",
};

/** Map one schema.org diet value (URL or member) to a lexicon token, or null. */
export function dietToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const member = value
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const suffix = MEMBER_TO_SUFFIX[member];
  return suffix ? `${NSID}#diet${suffix}` : null;
}

/** Map a string | string[] of schema.org diets to deduped lexicon tokens. */
export function dietTokens(value: unknown): string[] | undefined {
  const arr = Array.isArray(value) ? value : [value];
  const tokens = [...new Set(arr.map(dietToken).filter((t): t is string => t != null))];
  return tokens.length ? tokens : undefined;
}
