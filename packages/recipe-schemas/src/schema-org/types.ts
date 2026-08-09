/**
 * https://schema.org/Recipe and the types it references.
 *
 * Two layers, because reading and writing schema.org are different problems:
 *
 *   - `SchemaOrgRecipe` — the CANONICAL, emit-shaped document. Narrow and
 *     boring: one form per property. This is what we serialize into
 *     `<script type="application/ld+json">`, and it's the type fence for the
 *     emit path.
 *   - `WireRecipe` — a recipe node as it actually arrives from a page. Every
 *     property is `unknown` on purpose: schema.org's ranges are unions and real
 *     sites widen them further (`recipeYield` as a number, `image` as an
 *     `ImageObject`, `recipeInstructions` as one newline-joined blob). Naming
 *     the properties is the value here; `coerce.ts` narrows them.
 *
 * Nothing in this module knows about the atproto lexicon — see `../bridge`.
 */

/** schema.org ranges are single-or-repeated almost everywhere. */
export type OneOrMany<T> = T | T[];

export interface SchemaOrgPerson {
  "@type": "Person";
  name: string;
  url?: string;
}

export interface SchemaOrgOrganization {
  "@type": "Organization";
  name: string;
  url?: string;
}

export interface SchemaOrgImageObject {
  "@type": "ImageObject";
  url?: string;
  contentUrl?: string;
}

export interface SchemaOrgHowToStep {
  "@type": "HowToStep";
  text: string;
  name?: string;
}

export interface SchemaOrgHowToSection {
  "@type": "HowToSection";
  name?: string;
  itemListElement?: OneOrMany<SchemaOrgHowToStep | SchemaOrgHowToSection | string>;
}

/**
 * https://schema.org/NutritionInformation. Every field is a string with units
 * baked in ("210 calories", "11 g") — that's the spec, however unhelpful.
 */
export interface SchemaOrgNutritionInformation {
  "@type": "NutritionInformation";
  calories?: string;
  fatContent?: string;
  proteinContent?: string;
  carbohydrateContent?: string;
}

/** Canonical, emit-shaped https://schema.org/Recipe. */
export interface SchemaOrgRecipe {
  "@context": "https://schema.org";
  "@type": "Recipe";
  name: string;
  description?: string;
  image?: string[];
  author?: SchemaOrgPerson | SchemaOrgOrganization;
  datePublished?: string;
  /** ISO-8601 durations (`PT1H30M`) — schema.org's expected form. */
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  recipeYield?: string;
  recipeCuisine?: string;
  recipeCategory?: string;
  cookingMethod?: string;
  suitableForDiet?: RestrictedDietUrl[];
  /** schema.org wants one comma-separated string, not a list. */
  keywords?: string;
  recipeIngredient?: string[];
  recipeInstructions?: SchemaOrgHowToStep[];
  nutrition?: SchemaOrgNutritionInformation;
  url?: string;
}

/**
 * A Recipe node exactly as a page hands it to us — from JSON-LD, or assembled
 * from `itemprop` microdata (the itemprop names ARE the schema.org property
 * names, so both paths produce this same shape).
 */
export interface WireRecipe {
  "@context"?: unknown;
  "@type"?: unknown;
  "@graph"?: unknown;
  name?: unknown;
  description?: unknown;
  image?: unknown;
  author?: unknown;
  datePublished?: unknown;
  /** Correct property. */
  recipeIngredient?: unknown;
  /** Legacy misspelling plenty of sites still emit. */
  ingredients?: unknown;
  recipeInstructions?: unknown;
  prepTime?: unknown;
  cookTime?: unknown;
  totalTime?: unknown;
  recipeYield?: unknown;
  keywords?: unknown;
  suitableForDiet?: unknown;
  recipeCuisine?: unknown;
  recipeCategory?: unknown;
  cookingMethod?: unknown;
  nutrition?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

/** https://schema.org/RestrictedDiet member, as the full URL form we emit. */
export type RestrictedDietUrl = `https://schema.org/${RestrictedDietMember}`;

/** The complete https://schema.org/RestrictedDiet enumeration. */
export type RestrictedDietMember =
  | "DiabeticDiet"
  | "GlutenFreeDiet"
  | "HalalDiet"
  | "HinduDiet"
  | "KosherDiet"
  | "LowCalorieDiet"
  | "LowFatDiet"
  | "LowLactoseDiet"
  | "LowSaltDiet"
  | "VeganDiet"
  | "VegetarianDiet";

/** Nutrition with the units parsed off — grams and kcal as plain numbers. */
export interface ParsedNutrition {
  calories?: number;
  fatContent?: number;
  proteinContent?: number;
  carbohydrateContent?: number;
}

/**
 * A `WireRecipe` after `coerceRecipe`: every property narrowed to one form,
 * durations ISO-normalized, images absolutized, diets resolved to enum URLs.
 * Still pure schema.org — no lexicon tokens, no app vocab slugs.
 */
export interface CoercedSchemaOrgRecipe {
  name?: string;
  description?: string;
  imageUrls: string[];
  ingredients: string[];
  instructions: string[];
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  recipeYield?: string;
  keywords: string[];
  suitableForDiet: RestrictedDietUrl[];
  recipeCuisine?: string;
  recipeCategory?: string;
  cookingMethod?: string;
  nutrition?: ParsedNutrition;
  datePublished?: string;
  url?: string;
}
