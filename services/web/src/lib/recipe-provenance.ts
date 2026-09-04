import type { RecipeSource } from "#/lib/api/types";

/** The provenance DTOs live in the port's `types.ts` (offline plan §7 — every
 * wire shape is declared client-side and imported by the server). Re-exported
 * here so `deriveSource`'s callers keep getting the type from the function. */
export type { RecipeSource, SourceKind } from "#/lib/api/types";

/**
 * Shared recipe provenance derivation — the source kind / label / url logic used
 * by the public recipe page (`server/recipes.ts`), the household ledger, and the
 * household detail pane, so all three agree on "where did this recipe come from".
 * Client-safe (no DB imports): callers pass already-selected row fields.
 *
 * Factored out of `server/recipes.ts` (plan §5.2 / §11) rather than duplicated,
 * and moved under `lib/` when the offline plan banned client imports of
 * `#/server/**` (§4.3): this was always a client-safe pure module.
 */

/** did:plc:abcdef… → did:plc:abcdef (short, still recognizable). */
export function shortDid(did: string | null): string | null {
  if (!did) return null;
  return did.length > 24 ? `${did.slice(0, 21)}…` : did;
}

/**
 * Profile link for a publisher account. We route to the Bluesky appview, which
 * resolves any atproto account — including accounts whose handle lives on
 * another domain (e.g. *.blacksky.app). bsky.app's `/profile/` route needs the
 * HANDLE, not the DID, so a DID-only repo (handle unresolved) gets no link.
 * A handle's domain does NOT reliably indicate which appview its owner uses, so
 * bsky.app is the safe universal default; add alt-appview routing to
 * APPVIEW_OVERRIDES when a given handle-suffix → profile-URL scheme is known.
 */
const APPVIEW_OVERRIDES: Array<{ suffix: string; url: (handle: string) => string }> = [
  // e.g. { suffix: ".blacksky.app", url: (h) => `https://blacksky.app/profile/${h}` },
];

export function profileUrl(handle: string | null): string | null {
  if (!handle) return null;
  const hit = APPVIEW_OVERRIDES.find((o) => handle.endsWith(o.suffix));
  if (hit) return hit.url(handle);
  return `https://bsky.app/profile/${encodeURIComponent(handle)}`;
}

/** slug ("gluten_free") → label ("Gluten Free") for display. */
export function prettify(slug: string | null): string | null {
  if (!slug) return null;
  return slug
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Bare hostname of a URL ("https://www.smittenkitchen.com/…" → "smittenkitchen.com"). */
function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The single display name for an attribution row: what the recipe is credited
 * to (`displayName` → `author` → `publisher`), shared so a card and the detail
 * page can never credit the same recipe to two different names.
 */
export function attributionName(attr: { displayName: string | null; author: string | null; publisher: string | null } | null | undefined): string | null {
  if (!attr) return null;
  return attr.displayName ?? attr.author ?? attr.publisher ?? null;
}

/**
 * Derive the ledger/detail source label + glyph for a recipe, agreeing with the
 * public page's provenance. Priority:
 *   1. An attribution URL → `web` (external-link + bare domain), the most
 *      informative source for a recipe scraped from a site.
 *   2. A resolved atproto handle on the publishing repo → `handle`
 *      (book-open-text + `@handle`, linked to the profile).
 *   3. A named attribution without a URL (person/publication) → `note`
 *      (pencil + the name), the "handwritten / offline" provenance.
 *   4. Nothing — `null`, and every surface omits the line.
 *
 * Nothing here names the publishing *app*: an atproto record carries no trace of
 * the client that wrote it (the exchange.recipe.recipe lexicon has no client/via
 * field), so when none of 1–3 resolve we do not know where the recipe came from
 * and say nothing.
 */
export function deriveSource(row: {
  repoHandle: string | null;
  attrDisplayName: string | null;
  attrAuthor: string | null;
  attrPublisher: string | null;
  attrUrl: string | null;
}): RecipeSource | null {
  const domain = domainOf(row.attrUrl);
  if (domain && row.attrUrl) return { kind: "web", label: domain, url: row.attrUrl };

  if (row.repoHandle) return { kind: "handle", label: `@${row.repoHandle}`, url: profileUrl(row.repoHandle) };

  const attrName = row.attrDisplayName ?? row.attrAuthor ?? row.attrPublisher;
  if (attrName) return { kind: "note", label: attrName, url: null };

  return null;
}
