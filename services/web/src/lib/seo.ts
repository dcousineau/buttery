/**
 * Site-wide SEO / Open Graph defaults and a helper to build the per-route `meta`
 * array consumed by TanStack Router's `head()`.
 *
 * TanStack Start has no built-in OG image generator (unlike Next.js). The image
 * is a static asset in `public/` served from the site root. OG scrapers require
 * an *absolute* URL for `og:image`, so we resolve it against `siteUrl()`.
 *
 * Meta merging: `HeadContent` renders the union of `meta` from every matched
 * route and, for duplicate `name`/`property` keys, the last (deepest) wins — so
 * a child route's `seo()` call transparently overrides these root defaults.
 */

/** Public origin used to absolutize `og:image` / `og:url` / canonical. Sourced
 * from `VITE_APP_URL`, inlined by Vite at build time into BOTH the server and
 * client bundles — one deterministic value per environment, no host-dependent
 * drift. Set in `.railway/railway.ts` (mirrors `BETTER_AUTH_URL`) and `.env`. */
export function siteUrl(): string {
  return import.meta.env.VITE_APP_URL ?? "http://127.0.0.1:3000";
}

export const DEFAULT_SEO = {
  title: "Buttery",
  description: "Your recipes, your pantry — kept as portable atproto records you can take anywhere.",
  /** Static asset in `services/web/public/`. Replace with your own 1200×630 image. */
  image: "/og-image.png",
} as const;

export interface SeoInput {
  /** Page title. Falls back to the site default. */
  title?: string;
  description?: string;
  /** Absolute URL, or a root-relative path resolved against `siteUrl()`. */
  image?: string;
}

/** Resolve a path or URL against `siteUrl()`. Exported so the root document can
 * build the canonical / `og:url` from the current pathname. */
export function absolute(pathOrUrl: string): string {
  return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${siteUrl()}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/**
 * Build the `meta` array for a route `head()`. Pass nothing at the root for the
 * defaults; pass overrides on any child route.
 *
 *   export const Route = createFileRoute("/login")({
 *     head: () => ({ meta: seo({ title: "Sign in · Buttery" }) }),
 *   });
 */
export function seo(input: SeoInput = {}) {
  const title = input.title ?? DEFAULT_SEO.title;
  const description = input.description ?? DEFAULT_SEO.description;
  const image = absolute(input.image ?? DEFAULT_SEO.image);

  return [
    { title },
    { name: "description", content: description },

    // Open Graph
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: DEFAULT_SEO.title },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: image },
    { property: "og:image:type", content: "image/png" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: DEFAULT_SEO.title },
    // og:url + <link rel="canonical"> are emitted globally from the current
    // pathname in __root.tsx — they're per-page and can't be defaulted here.
  ];
}
