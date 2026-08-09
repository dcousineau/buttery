import type { WireRecipe } from "@buttery/recipe-schemas/schema-org";
import { isRecipeNode } from "@buttery/recipe-schemas/schema-org";
import { schemaOrgToLexicon } from "@buttery/recipe-schemas/bridge";
import type { ExtractedRecipe, ParsedInput } from "../types.ts";

/**
 * schema.org/Recipe from `<script type="application/ld+json">`. The richest and
 * most reliable source, so it runs first.
 *
 * This module's only job is FINDING the node — the shapes real sites emit
 * (`@graph` wrappers, top-level arrays, `@type` as a string or array). What the
 * node's properties mean is `@buttery/recipe-schemas`' job, so JSON-LD and
 * microdata share one mapping.
 */
export function fromJsonLd({ root, url }: ParsedInput): ExtractedRecipe | null {
  const node = findRecipeNode(root);
  if (!node) return null;
  return schemaOrgToLexicon(node, url);
}

/** Walk every ld+json block (and nested @graph/arrays) for the first Recipe node. */
function findRecipeNode(root: ParsedInput["root"]): WireRecipe | null {
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let data: unknown;
    try {
      // rawText avoids the parser's entity decoding corrupting the JSON payload.
      data = JSON.parse(script.rawText.trim());
    } catch {
      continue;
    }
    const found = search(data);
    if (found) return found;
  }
  return null;
}

function search(data: unknown): WireRecipe | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = search(item);
      if (found) return found;
    }
    return null;
  }
  if (data && typeof data === "object") {
    if (isRecipeNode(data)) return data;
    const graph = (data as Record<string, unknown>)["@graph"];
    if (graph) return search(graph);
  }
  return null;
}
