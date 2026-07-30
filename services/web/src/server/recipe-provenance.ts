/**
 * Shared recipe provenance derivation — the source kind / label / url logic used
 * by the public recipe page (`server/recipes.ts`), the household ledger, and the
 * household detail pane, so all three agree on "where did this recipe come from".
 * Client-safe (no DB imports): callers pass already-selected row fields.
 *
 * Factored out of `server/recipes.ts` (plan §5.2 / §11) rather than duplicated.
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

/**
 * Best-effort "which app published this" + a deep link to the recipe there.
 * atproto records carry NO provenance of the writing app — the
 * exchange.recipe.recipe lexicon has no client/via field — so this is a
 * heuristic, not a fact:
 *   - origin 'local' → Buttery wrote it (we know; we're the writer). No external
 *     link — the recipe already lives here.
 *   - origin 'sync'  → recipe.exchange is currently the only app publishing this
 *     NSID to the network. Its canonical URL is `/recipes/{rkey}`, and our
 *     recipe.id IS the rkey (a ULID), so the deep link is derivable. Revisit if
 *     a second producer ever appears.
 */
export function deriveApp(origin: string, id: string): { name: string; url: string | null } {
  if (origin === "local") return { name: "Buttery", url: null };
  return { name: "recipe.exchange", url: `https://recipe.exchange/recipes/${encodeURIComponent(id)}` };
}

/** The three provenance glyphs the design maps: web / handwritten-note / atproto handle. */
export type SourceKind = "web" | "note" | "handle";

/** A recipe's display provenance: an icon-keyed kind, a label, and an optional link. */
export interface RecipeSource {
  kind: SourceKind;
  label: string;
  url: string | null;
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
 * Derive the ledger/detail source label + glyph for a recipe, agreeing with the
 * public page's provenance. Priority:
 *   1. An attribution URL → `web` (external-link + bare domain), the most
 *      informative source for a recipe scraped from a site.
 *   2. A resolved atproto handle on the publishing repo → `handle`
 *      (book-open-text + `@handle`, linked to the profile).
 *   3. A named attribution without a URL (person/publication) → `note`
 *      (pencil + the name), the "handwritten / offline" provenance.
 *   4. Fallback to the publishing app (Buttery = `note`, recipe.exchange = `handle`).
 */
export function deriveSource(row: {
  origin: string;
  id: string;
  repoHandle: string | null;
  attrDisplayName: string | null;
  attrAuthor: string | null;
  attrPublisher: string | null;
  attrUrl: string | null;
}): RecipeSource {
  const domain = domainOf(row.attrUrl);
  if (domain && row.attrUrl) return { kind: "web", label: domain, url: row.attrUrl };

  if (row.repoHandle) return { kind: "handle", label: `@${row.repoHandle}`, url: profileUrl(row.repoHandle) };

  const attrName = row.attrDisplayName ?? row.attrAuthor ?? row.attrPublisher;
  if (attrName) return { kind: "note", label: attrName, url: null };

  const app = deriveApp(row.origin, row.id);
  return { kind: row.origin === "local" ? "note" : "handle", label: app.name, url: app.url };
}
