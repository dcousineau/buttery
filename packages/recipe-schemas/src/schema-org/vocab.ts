import type { RestrictedDietMember, RestrictedDietUrl } from "./types.ts";

/**
 * schema.org constants and its one controlled vocabulary we care about,
 * RestrictedDiet. Pure schema.org: the crosswalk to Buttery's own diet vocab
 * lives in `../bridge/vocab.ts`.
 */

export const SCHEMA_ORG_CONTEXT = "https://schema.org" as const;
export const SCHEMA_ORG_PREFIX = "https://schema.org/";

/** Every member of https://schema.org/RestrictedDiet. */
export const RESTRICTED_DIET_MEMBERS = [
  "DiabeticDiet",
  "GlutenFreeDiet",
  "HalalDiet",
  "HinduDiet",
  "KosherDiet",
  "LowCalorieDiet",
  "LowFatDiet",
  "LowLactoseDiet",
  "LowSaltDiet",
  "VeganDiet",
  "VegetarianDiet",
] as const satisfies readonly RestrictedDietMember[];

const BY_LOWER = new Map<string, RestrictedDietMember>(RESTRICTED_DIET_MEMBERS.map((m) => [m.toLowerCase(), m]));

/** `https://schema.org/VeganDiet` for a member name. */
export function dietUrl(member: RestrictedDietMember): RestrictedDietUrl {
  return `${SCHEMA_ORG_PREFIX}${member}`;
}

/**
 * Accept either form a page might emit — the full URL (`http` or `https`, with
 * or without a trailing slash) or the bare member ("VeganDiet") — and return the
 * canonical member, or null if it isn't a RestrictedDiet at all.
 */
export function dietMember(value: unknown): RestrictedDietMember | null {
  if (typeof value !== "string") return null;
  const bare = value
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return BY_LOWER.get(bare) ?? null;
}

/** Normalize one diet value to its canonical URL form, or null. */
export function dietUrlFrom(value: unknown): RestrictedDietUrl | null {
  const member = dietMember(value);
  return member ? dietUrl(member) : null;
}
