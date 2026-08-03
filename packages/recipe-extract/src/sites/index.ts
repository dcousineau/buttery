import type { SiteExtractor } from "../types.ts";

/**
 * Per-host extractor registry. Empty today — the generic JSON-LD → microdata →
 * heuristics pipeline covers the vast majority of recipe sites. Add an adapter
 * here only when a specific host earns it: the `recipe_import_attempt` table
 * (Phase B) surfaces which hosts fail most, and that's the signal to build one.
 *
 * ## Adding a site adapter
 *
 * 1. Create `sites/<host>.ts` exporting a `SiteExtractor`:
 *
 *        import type { SiteExtractor } from "../types.ts";
 *        export const allrecipes: SiteExtractor = {
 *          hosts: ["allrecipes.com"],
 *          extract({ root, url }) {
 *            // pull fields off `root` (node-html-parser); return null to fall
 *            // through to the generic pipeline.
 *            return { name: ... };
 *          },
 *        };
 *
 * 2. Register it in `REGISTRY` below.
 *
 * Adapters run BEFORE the generic pipeline and their fields take precedence, but
 * the orchestrator still backfills anything they leave undefined from JSON-LD/
 * microdata — so an adapter only needs to fix the parts a site gets wrong.
 */
const REGISTRY: SiteExtractor[] = [];

/** Bare host of a URL ("www.foo.com" → "foo.com"), or null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The adapter registered for this URL's host, or null. */
export function findSiteExtractor(url: string): SiteExtractor | null {
  const host = hostOf(url);
  if (!host) return null;
  return REGISTRY.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}
