import type { RestrictedDietMember, RestrictedDietUrl } from "../schema-org/types.ts";
import { dietMember, dietUrl } from "../schema-org/vocab.ts";

/**
 * The diet crosswalk — the one table that knows all three names for a diet:
 *
 *   slug       what the DB and the web app use (`recipe_vocab` seed in migration
 *              1785300000000, mirrored by the app's `recipe-vocab.ts`)
 *   suffix     the `exchange.recipe.defs#diet<Suffix>` lexicon token suffix
 *   schemaOrg  the https://schema.org/RestrictedDiet member, or null
 *
 * Before this table the crosswalk existed twice, in opposite directions and out
 * of sync: the import parser's schema.org→token map and the recipe page's
 * token→schema.org map, which carried three members (Hindu, LowLactose,
 * LowSalt) that aren't in our vocab at all and so could never match.
 *
 * Keto, LowCarb, and Paleo are the reverse gap: in our vocab, absent from
 * RestrictedDiet. Imports can't set them (they ride along as keywords instead)
 * and we can't advertise them in JSON-LD.
 */

const NSID = "exchange.recipe.defs";

export interface DietMapping {
  /** App/DB slug — `snakeCase(suffix)`, matching `recipe-vocab.ts`. */
  slug: string;
  /** Lexicon token suffix; the full token is `exchange.recipe.defs#diet<Suffix>`. */
  suffix: string;
  /** schema.org RestrictedDiet member, or null when schema.org has none. */
  schemaOrg: RestrictedDietMember | null;
}

export const DIET_MAPPINGS = [
  { slug: "diabetic", suffix: "Diabetic", schemaOrg: "DiabeticDiet" },
  { slug: "gluten_free", suffix: "GlutenFree", schemaOrg: "GlutenFreeDiet" },
  { slug: "halal", suffix: "Halal", schemaOrg: "HalalDiet" },
  { slug: "keto", suffix: "Keto", schemaOrg: null },
  { slug: "kosher", suffix: "Kosher", schemaOrg: "KosherDiet" },
  { slug: "low_calorie", suffix: "LowCalorie", schemaOrg: "LowCalorieDiet" },
  { slug: "low_carb", suffix: "LowCarb", schemaOrg: null },
  { slug: "low_fat", suffix: "LowFat", schemaOrg: "LowFatDiet" },
  { slug: "paleo", suffix: "Paleo", schemaOrg: null },
  { slug: "vegan", suffix: "Vegan", schemaOrg: "VeganDiet" },
  { slug: "vegetarian", suffix: "Vegetarian", schemaOrg: "VegetarianDiet" },
] as const satisfies readonly DietMapping[];

/** `exchange.recipe.defs#diet<Suffix>` for a mapping. */
export function dietToken(mapping: DietMapping): string {
  return `${NSID}#diet${mapping.suffix}`;
}

const BY_SCHEMA_ORG = new Map<RestrictedDietMember, DietMapping>(DIET_MAPPINGS.filter((d) => d.schemaOrg != null).map((d) => [d.schemaOrg as RestrictedDietMember, d]));
const BY_SLUG = new Map<string, DietMapping>(DIET_MAPPINGS.map((d) => [d.slug, d]));
const BY_TOKEN = new Map<string, DietMapping>(DIET_MAPPINGS.map((d) => [dietToken(d), d]));

/** One schema.org diet (URL or bare member) → lexicon token, or null. */
export function dietTokenFromSchemaOrg(value: unknown): string | null {
  const member = dietMember(value);
  if (!member) return null;
  const mapping = BY_SCHEMA_ORG.get(member);
  return mapping ? dietToken(mapping) : null;
}

/** A string | string[] of schema.org diets → deduped lexicon tokens. */
export function dietTokensFromSchemaOrg(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : [value];
  return [...new Set(arr.map(dietTokenFromSchemaOrg).filter((t): t is string => t != null))];
}

/** App diet slug → schema.org RestrictedDiet URL, or null if it has no member. */
export function dietUrlForSlug(slug: string | null | undefined): RestrictedDietUrl | null {
  const mapping = slug ? BY_SLUG.get(slug) : undefined;
  return mapping?.schemaOrg ? dietUrl(mapping.schemaOrg) : null;
}

/** App diet slugs → schema.org URLs, dropping the ones schema.org can't express. */
export function dietUrlsForSlugs(slugs: readonly string[] | null | undefined): RestrictedDietUrl[] {
  return [...new Set((slugs ?? []).map(dietUrlForSlug).filter((u): u is RestrictedDietUrl => u != null))];
}

/** Lexicon token → app diet slug, or null. */
export function dietSlugFromToken(token: string | null | undefined): string | null {
  return (token ? BY_TOKEN.get(token)?.slug : undefined) ?? null;
}
