import { parse } from "node-html-parser";
import type { ExtractInput, ExtractResult, ExtractedRecipe, ExtractorName, ExtractWarning, ParsedInput } from "./types.ts";
import { fromJsonLd } from "./parse/jsonld.ts";
import { fromMicrodata } from "./parse/microdata.ts";
import { fromHRecipe } from "./parse/hrecipe.ts";
import { fromHeuristics } from "./parse/heuristics.ts";
import { findSiteExtractor } from "./sites/index.ts";

/**
 * Extract a recipe from a page's raw HTML. Pure: no network, no DB — hand it
 * bytes you already fetched (the web app's safe-fetch does that) and it returns
 * a lexicon-shaped `ExtractedRecipe` plus which path produced it and any soft
 * warnings.
 *
 * Strategy, highest-confidence first:
 *   1. a bespoke site adapter (if one is registered for the host),
 *   2. schema.org JSON-LD,
 *   3. schema.org microdata,
 *   4. microformats hRecipe / h-recipe,
 *   5. coarse heuristics (title/image only).
 *
 * Fields are merged across sources: the primary (first source to yield a recipe
 * body) wins, and later sources only backfill fields it left blank. `extractor`
 * names the primary. `ok` means we got a name plus ingredients or instructions —
 * enough to be worth prefilling; below that the caller treats it as a failed
 * scrape (offer the manual/bookmarklet fallback) while still using whatever
 * partial fields came back to seed the form.
 */
export function extractRecipe(input: ExtractInput): ExtractResult {
  const root = parse(input.html);
  const parsed: ParsedInput = { ...input, root };

  const sources: Array<{ name: ExtractorName; recipe: ExtractedRecipe | null }> = [];

  const site = findSiteExtractor(input.url);
  if (site) {
    const host = new URL(input.url).hostname.replace(/^www\./, "").toLowerCase();
    sources.push({ name: `site:${host}`, recipe: safe(() => site.extract(parsed)) });
  }
  sources.push({ name: "jsonld", recipe: safe(() => fromJsonLd(parsed)) });
  sources.push({ name: "microdata", recipe: safe(() => fromMicrodata(parsed)) });
  sources.push({ name: "hrecipe", recipe: safe(() => fromHRecipe(parsed)) });
  sources.push({ name: "heuristics", recipe: safe(() => fromHeuristics(parsed)) });

  // Merge: iterate in priority order, backfilling only-undefined fields. The
  // primary extractor is the first source that produced a recipe body.
  const merged: ExtractedRecipe = {};
  let primary: ExtractorName | null = null;
  for (const { name, recipe } of sources) {
    if (!recipe) continue;
    if (primary == null && hasBody(recipe)) primary = name;
    backfill(merged, recipe);
  }

  const ok = !!merged.name && ((merged.ingredients?.length ?? 0) > 0 || (merged.instructions?.length ?? 0) > 0);
  return { ok, recipe: merged, extractor: ok ? primary : primary, warnings: warn(merged) };
}

/** A recipe "body" = the parts that make it worth prefilling. */
function hasBody(r: ExtractedRecipe): boolean {
  return !!r.name && ((r.ingredients?.length ?? 0) > 0 || (r.instructions?.length ?? 0) > 0);
}

/** Copy fields from `src` into `dst` only where `dst` doesn't have them yet. */
function backfill(dst: ExtractedRecipe, src: ExtractedRecipe): void {
  const keys = Object.keys(src) as Array<keyof ExtractedRecipe>;
  for (const k of keys) {
    const val = src[k];
    if (val == null) continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (dst[k] == null || (Array.isArray(dst[k]) && (dst[k] as unknown[]).length === 0)) {
      // vocab is an object — shallow-merge rather than replace.
      if (k === "vocab" && dst.vocab) {
        dst.vocab = { ...src.vocab, ...dst.vocab };
      } else {
        (dst as Record<string, unknown>)[k] = val;
      }
    }
  }
}

function warn(r: ExtractedRecipe): ExtractWarning[] {
  const out: ExtractWarning[] = [];
  if (!r.name) out.push({ field: "name", message: "Couldn't find a title on the page." });
  if (!r.ingredients?.length) out.push({ field: "ingredients", message: "Couldn't read an ingredients list — you'll need to add them." });
  if (!r.instructions?.length) out.push({ field: "instructions", message: "Couldn't read the steps — you'll need to add them." });
  return out;
}

function safe(fn: () => ExtractedRecipe | null): ExtractedRecipe | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
