import type { HTMLElement } from "node-html-parser";
import type { WireRecipe } from "@buttery/recipe-schemas/schema-org";
import { schemaOrgToLexicon } from "@buttery/recipe-schemas/bridge";
import type { ExtractedRecipe, ParsedInput } from "../types.ts";

/**
 * schema.org microdata (`itemprop=…`) fallback for pages that don't ship JSON-LD.
 *
 * `itemprop` names ARE schema.org property names, so this walks the DOM into the
 * same `WireRecipe` object JSON-LD arrives as and hands it to the same mapping.
 * That's the whole point of the split: microdata pages get keywords, nutrition,
 * diets, and cuisine/category for free instead of the thin subset a
 * separately-maintained mapper used to cover.
 *
 * Scoped to the nearest `[itemtype*="Recipe"]` container when present so we don't
 * pull `itemprop`s from unrelated widgets; falls back to the whole document.
 */
export function fromMicrodata({ root, url }: ParsedInput): ExtractedRecipe | null {
  const scope = root.querySelector('[itemtype*="Recipe" i]') ?? root;
  const node = readItem(scope) as WireRecipe;
  const recipe = schemaOrgToLexicon(node, url);

  // Considered usable only if we got a name and some body — otherwise let
  // heuristics try (a stray `itemprop="name"` on a nav element isn't a recipe).
  if (!recipe.name || (!recipe.ingredients?.length && !recipe.instructions?.length)) return null;
  return recipe;
}

/**
 * One microdata item → a plain object. Repeated properties become arrays (which
 * is exactly how JSON-LD carries them), and a nested `itemscope` becomes a
 * nested object — that's how `nutrition` arrives.
 */
function readItem(scope: HTMLElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const el of ownProperties(scope)) {
    const name = el.getAttribute("itemprop")?.trim();
    if (!name) continue;
    const value = el.hasAttribute("itemscope") ? readItem(el) : elementValue(el);
    if (value == null) continue;
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  return out;
}

/**
 * The `[itemprop]` elements belonging to THIS item: descendants with no other
 * `itemscope` between them and `scope`. Without this, a nested
 * `NutritionInformation`'s `calories` would also be read as the recipe's own.
 */
function ownProperties(scope: HTMLElement): HTMLElement[] {
  return scope.querySelectorAll("[itemprop]").filter((el) => {
    const owner = nearestScope(el, scope);
    // null = we walked off the top without finding an intervening itemscope,
    // which only happens on the whole-document fallback scope. Still ours.
    return owner === scope || owner === null;
  });
}

function nearestScope(el: HTMLElement, stopAt: HTMLElement): HTMLElement | null {
  let parent: HTMLElement | null = el.parentNode;
  while (parent && parent !== stopAt) {
    if (parent.hasAttribute("itemscope")) return parent;
    parent = parent.parentNode;
  }
  return parent;
}

/**
 * A property element's value, per the microdata spec's ordering: an explicit
 * `content` attribute wins everywhere (that's how `<div itemprop="totalTime"
 * content="PT45M">45 minutes</div>` works), then the element-specific attribute,
 * then the text.
 */
function elementValue(el: HTMLElement): string | undefined {
  const content = trimmed(el.getAttribute("content"));
  if (content) return content;

  switch (el.tagName?.toLowerCase()) {
    case "meta":
      return undefined; // no content attribute → nothing to read
    case "time":
      return trimmed(el.getAttribute("datetime")) ?? trimmed(el.text);
    case "img":
    case "audio":
    case "embed":
    case "iframe":
    case "source":
    case "track":
    case "video":
      return trimmed(el.getAttribute("src"));
    case "a":
    case "area":
    case "link":
      return trimmed(el.getAttribute("href"));
    case "object":
      return trimmed(el.getAttribute("data"));
    case "data":
    case "meter":
      return trimmed(el.getAttribute("value")) ?? trimmed(el.text);
    default:
      return trimmed(el.text);
  }
}

function trimmed(v: string | undefined): string | undefined {
  const s = v?.replace(/\s+/g, " ").trim();
  return s ? s : undefined;
}
