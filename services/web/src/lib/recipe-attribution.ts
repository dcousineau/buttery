/**
 * Client-safe attribution helpers for the recipe create form. Buttery enforces
 * attribution (the lexicon marks it optional); this module knows the six union
 * shapes, their REQUIRED fields (mirroring exchange.recipe.defs exactly so the
 * server's `recipe.safeValidate` agrees), and how to (de)serialize form state to
 * the lexicon `attribution` object. No DB / server imports.
 */

export type AttributionType = "original" | "person" | "publication" | "website" | "show" | "product";

export interface AttributionFieldDef {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  /** Stored as an integer in the record (e.g. publication page). */
  integer?: boolean;
}

/** The select options, in the mockup's order + copy. */
export const ATTRIBUTION_TYPES: { value: AttributionType; label: string }[] = [
  { value: "original", label: "Original — I wrote this" },
  { value: "person", label: "A person" },
  { value: "publication", label: "A book or magazine" },
  { value: "website", label: "A website" },
  { value: "show", label: "A show or episode" },
  { value: "product", label: "A product or package" },
];

/** License options for Original (values are the lexicon `license` enum). */
export const LICENSE_OPTIONS: { value: string; label: string }[] = [
  { value: "cc_by", label: "CC BY — credit me, use it freely" },
  { value: "cc_by_sa", label: "CC BY-SA — credit and share alike" },
  { value: "cc_by_nc", label: "CC BY-NC — credit, non-commercial" },
  { value: "public_domain", label: "CC0 — public domain" },
  { value: "all_rights", label: "All rights reserved" },
];

// Non-license fields per type. `original` has only its license select (handled
// separately). Keys map 1:1 to the lexicon union member's properties.
export const ATTRIBUTION_FIELDS: Record<AttributionType, AttributionFieldDef[]> = {
  original: [],
  person: [
    { key: "name", label: "Name", placeholder: "Deb Perelman", required: true },
    { key: "url", label: "atproto handle or link", placeholder: "@deb.bsky.social", required: false },
  ],
  publication: [
    { key: "title", label: "Publication", placeholder: "Bittman's Kitchen Express", required: true },
    { key: "author", label: "Author", placeholder: "Mark Bittman", required: true },
    { key: "publisher", label: "Publisher", placeholder: "Clarkson Potter", required: false },
    { key: "page", label: "Page", placeholder: "142", required: false, integer: true },
  ],
  website: [
    { key: "name", label: "Site", placeholder: "Smitten Kitchen", required: true },
    { key: "url", label: "URL", placeholder: "https://smittenkitchen.com/…", required: true },
  ],
  show: [
    { key: "title", label: "Show", placeholder: "Salt Fat Acid Heat", required: true },
    { key: "network", label: "Network", placeholder: "Netflix", required: true },
    { key: "episode", label: "Episode", placeholder: "Fat", required: false },
  ],
  product: [
    { key: "name", label: "Product", placeholder: "Nestlé Toll House morsels", required: true },
    { key: "brand", label: "Brand", placeholder: "Nestlé", required: true },
    { key: "url", label: "URL", placeholder: "https://…", required: false },
  ],
};

const TYPE_NSID: Record<AttributionType, string> = {
  original: "exchange.recipe.defs#attributionOriginal",
  person: "exchange.recipe.defs#attributionPerson",
  publication: "exchange.recipe.defs#attributionPublication",
  website: "exchange.recipe.defs#attributionWebsite",
  show: "exchange.recipe.defs#attributionShow",
  product: "exchange.recipe.defs#attributionProduct",
};

export interface AttributionState {
  type: AttributionType | "";
  values: Record<string, string>;
  license: string;
}

export const EMPTY_ATTRIBUTION: AttributionState = { type: "", values: {}, license: "" };

/** True once every required field for the chosen type is filled. */
export function attributionComplete(state: AttributionState): boolean {
  if (!state.type) return false;
  if (state.type === "original") return !!state.license;
  return ATTRIBUTION_FIELDS[state.type].filter((f) => f.required).every((f) => (state.values[f.key] ?? "").trim());
}

/**
 * Build the lexicon `attribution` object from form state, or null if incomplete.
 * Optional empty fields are dropped so the record stays clean.
 */
export function buildAttribution(state: AttributionState): Record<string, unknown> | null {
  if (!attributionComplete(state)) return null;
  const type = state.type as AttributionType;
  const out: Record<string, unknown> = { $type: TYPE_NSID[type] };
  if (type === "original") {
    out.license = state.license;
    return out;
  }
  for (const f of ATTRIBUTION_FIELDS[type]) {
    const raw = (state.values[f.key] ?? "").trim();
    if (!raw) continue;
    out[f.key] = f.integer ? Number.parseInt(raw, 10) : raw;
    if (f.integer && Number.isNaN(out[f.key])) delete out[f.key];
  }
  return out;
}

/** Reverse: hydrate form state from an existing attribution object (import/edit). */
export function attributionToState(attr: Record<string, unknown> | null | undefined): AttributionState {
  if (!attr || typeof attr.$type !== "string") return { ...EMPTY_ATTRIBUTION };
  const entry = (Object.entries(TYPE_NSID) as [AttributionType, string][]).find(([, nsid]) => nsid === attr.$type);
  if (!entry) return { ...EMPTY_ATTRIBUTION };
  const type = entry[0];
  const values: Record<string, string> = {};
  for (const f of ATTRIBUTION_FIELDS[type]) {
    const v = attr[f.key];
    if (v != null) values[f.key] = String(v);
  }
  return { type, values, license: typeof attr.license === "string" ? attr.license : "" };
}
