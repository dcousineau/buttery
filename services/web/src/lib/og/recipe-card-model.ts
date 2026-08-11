/**
 * The pure model behind the per-recipe Open Graph card, plus the version token
 * that lets us cache the rendered PNG forever.
 *
 * This lives in `lib/` rather than next to the renderer because BOTH sides need
 * it and only one of them is server-side:
 *   - `src/server/og/recipe-og.tsx` renders it (satori + resvg + ~400 KB of
 *     vendored fonts — server only, and it must stay that way);
 *   - `routes/recipes.$id.tsx` has to build the `og:image` URL during SSR *and*
 *     during client-side navigation, so whatever it imports ships to the browser.
 * Keeping the projection here means the URL's version token is derived from the
 * exact same model the renderer draws — there is no second field list to keep in
 * sync, and no way for the two to drift apart.
 *
 * Client-safe: no DB, no network, no `node:*`. `formatDuration` is already on
 * every recipe page.
 */
import { formatDuration } from "#/lib/format";
import type { RecipeDetailData } from "#/server/recipes";

/**
 * Bump whenever the *design* changes — a new field on the card, different chip
 * rules, a new layout.
 *
 * It feeds both the URL's `?v=` token and the server's ETag, so one edit here
 * retires every cached image everywhere: browser caches, the CDN, and Redis. That
 * matters more than usual because the image URL is served `immutable` (see
 * `routes/recipes.$id_.og[.]png.ts`) — without this, a layout fix would take a
 * year to reach anyone holding a cached card.
 */
export const OG_LAYOUT_VERSION = 1;

export interface RecipeOgModel {
  id: string;
  title: string;
  /** Kicker above the source pill, e.g. "FROM A BOOK" / "BY" / "FROM". null when unknown. */
  sourceKicker: string | null;
  /** Source pill text, e.g. "Bittman's Kitchen Express — Mark Bittman" or "smittenkitchen.com". */
  sourceLabel: string | null;
  description: string | null;
  /** Short brag chips, max 4, e.g. ["45 min", "Serves 4", "12 ingredients", "Italian"]. */
  facts: string[];
  /** atproto publisher handle line for the footer, e.g. "@deb.bsky.social". */
  publishedBy: string | null;
  /** Absolute URL of the hero image to *try* to embed, or null. */
  heroUrl: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A display name that is itself a URL or a bare domain ("smittenkitchen.com")
 * isn't a name — for those we'd rather show the clean hostname than repeat the
 * URL twice with different punctuation.
 */
function looksLikeName(value: string): boolean {
  return !/^https?:\/\//i.test(value) && !/^[\w-]+(\.[\w-]+)+$/.test(value);
}

/** Hostname of a URL with the cosmetic `www.` removed, or null if unparseable. */
function prettyHost(url: string | null): string | null {
  const raw = nonEmpty(url);
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

interface SourceLine {
  kicker: string | null;
  label: string | null;
}

/**
 * Turn the attribution row into the kicker + pill pair. Attribution is the thing
 * Buttery insists on (see lib/recipe-attribution.ts), so it gets the loudest
 * non-title slot in the image; the publishing atproto account is the fallback
 * when a recipe somehow has no attribution at all.
 */
function deriveSource(recipe: RecipeDetailData): SourceLine {
  const attr = recipe.attribution;
  const handle = nonEmpty(recipe.publishedBy);

  if (!attr) {
    return handle ? { kicker: "SHARED BY", label: handle } : { kicker: null, label: null };
  }

  const displayName = nonEmpty(attr.displayName);
  const author = nonEmpty(attr.author);
  const publisher = nonEmpty(attr.publisher);
  const host = prettyHost(attr.url);

  switch (attr.kind) {
    case "publication": {
      // The book's title carries the credit; the author rides along after an em
      // dash when we know it. A title-less row still beats showing nothing.
      const title = displayName ?? author ?? publisher;
      if (!title) return { kicker: null, label: null };
      const label = displayName && author ? `${displayName} — ${author}` : title;
      return { kicker: "FROM A BOOK", label };
    }
    case "person": {
      const name = displayName ?? author;
      return name ? { kicker: "BY", label: name } : { kicker: null, label: null };
    }
    case "website": {
      // "Smitten Kitchen" reads better than "smittenkitchen.com", but only when
      // the stored name is actually a name and not the domain typed again.
      const name = displayName && looksLikeName(displayName) ? displayName : null;
      const label = name ?? host ?? displayName;
      return label ? { kicker: "FROM", label } : { kicker: null, label: null };
    }
    case "show": {
      const label = displayName ?? publisher;
      return label ? { kicker: "FROM THE SHOW", label } : { kicker: null, label: null };
    }
    case "product": {
      const label = displayName ?? publisher;
      return label ? { kicker: "FROM", label } : { kicker: null, label: null };
    }
    case "original": {
      // An original has no external name to cite, so the credit is the account
      // that wrote it — which is the whole point of publishing on your own PDS.
      const label = displayName ?? author ?? handle;
      return label ? { kicker: "AN ORIGINAL BY", label } : { kicker: null, label: null };
    }
    default: {
      const label = displayName ?? author ?? publisher ?? host ?? handle;
      return label ? { kicker: "FROM", label } : { kicker: null, label: null };
    }
  }
}

/** "4" → "Serves 4"; "2 loaves" → "2 loaves"; "a dozen" → "A dozen". */
function formatYield(raw: string): string {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return `Serves ${value}`;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Satori has no `line-clamp` and no text overflow of any kind — a string that
 * doesn't fit simply pushes the layout off the canvas. So every string is cut to
 * a character budget before it reaches the tree.
 */
export function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars - 1);
  // Break on a word boundary when there is one within reach — "…for a crowd"
  // cut to "…for a" reads as an abbreviation, "…for a cro" reads as a bug. A
  // boundary further back than 70% of the budget throws away too much.
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace >= maxChars * 0.7 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd().replace(/[,;:—-]$/, "")}…`;
}

/**
 * Everything the picture needs, and nothing else. Pure — no DB, no network, no
 * clock — so the interesting decisions are covered by plain unit tests.
 */
export function recipeOgModel(recipe: RecipeDetailData): RecipeOgModel {
  const { kicker, label } = deriveSource(recipe);

  // Priority order, first four survive. A chip is only worth 22px of a 630px
  // image if it says something a glance can use.
  const duration = nonEmpty(recipe.totalTime) ?? nonEmpty(recipe.cookTime) ?? nonEmpty(recipe.prepTime);
  const yieldText = nonEmpty(recipe.recipeYield);
  const ingredientCount = recipe.ingredients.length;
  const candidates: Array<string | null> = [
    duration ? formatDuration(duration) : null,
    yieldText ? formatYield(yieldText) : null,
    ingredientCount > 0 ? `${ingredientCount} ingredient${ingredientCount === 1 ? "" : "s"}` : null,
    nonEmpty(recipe.cuisine) ?? nonEmpty(recipe.category) ?? nonEmpty(recipe.cookingMethod),
    nonEmpty(recipe.suitableForDiet[0]),
    recipe.calories != null ? `${recipe.calories} cal` : null,
  ];

  return {
    id: recipe.id,
    title: recipe.name,
    sourceKicker: label ? kicker : null,
    sourceLabel: label,
    description: nonEmpty(recipe.description),
    facts: candidates
      .filter((c): c is string => c != null)
      .map((c) => clamp(c, 24))
      .slice(0, 4),
    publishedBy: nonEmpty(recipe.publishedBy),
    heroUrl: recipe.images[0]?.url ?? null,
  };
}

/**
 * The `?v=` token stamped onto the card's URL.
 *
 * The point is cacheability: a URL that changes whenever the picture changes can
 * be served `immutable` with a one-year TTL, which is what makes a CDN (and every
 * scraper's own cache) hold it instead of revalidating. Edit the recipe and the
 * page emits a different URL, which is a cache miss by construction — no purge
 * step, nothing to forget.
 *
 * FNV-1a rather than SHA-256 because this half runs in the browser: it is eight
 * characters of cache-busting, not a security boundary. The server keeps its own
 * SHA-256 fingerprint for the ETag.
 */
export function recipeOgVersion(model: RecipeOgModel): string {
  const payload = `${OG_LAYOUT_VERSION}:${JSON.stringify(model)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
