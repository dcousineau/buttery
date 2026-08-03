import type { HTMLElement } from "node-html-parser";
import type { ExtractedRecipe, ParsedInput } from "../types.ts";
import { absoluteUrl, cleanText } from "../normalize/text.ts";
import { toIsoDuration } from "../normalize/duration.ts";

/**
 * schema.org microdata (`itemprop=…`) fallback for pages that don't ship JSON-LD.
 * Scoped to the nearest `[itemtype*="Recipe"]` container when present so we don't
 * pull `itemprop`s from unrelated widgets; falls back to the whole document.
 */
export function fromMicrodata({ root, url }: ParsedInput): ExtractedRecipe | null {
  const scope = root.querySelector('[itemtype*="Recipe" i]') ?? root;
  const out: ExtractedRecipe = {};

  const name = prop(scope, "name");
  if (name) out.name = name;

  const text = prop(scope, "description");
  if (text) out.text = text;

  const ingredients = props(scope, "recipeIngredient");
  const ingredientsAlt = ingredients.length ? ingredients : props(scope, "ingredients");
  if (ingredientsAlt.length) out.ingredients = ingredientsAlt;

  const instructions = props(scope, "recipeInstructions");
  if (instructions.length) out.instructions = instructions;

  const prep = toIsoDuration(propAttr(scope, "prepTime"));
  if (prep) out.prepTime = prep;
  const cook = toIsoDuration(propAttr(scope, "cookTime"));
  if (cook) out.cookTime = cook;
  const total = toIsoDuration(propAttr(scope, "totalTime"));
  if (total) out.totalTime = total;

  const yieldStr = prop(scope, "recipeYield");
  if (yieldStr) out.recipeYield = yieldStr;

  const image = imageProp(scope, url);
  if (image) out.imageUrl = image;

  // Considered usable only if we got a name and some body — otherwise let
  // heuristics try (a stray `itemprop="name"` on a nav element isn't a recipe).
  if (!out.name || (!out.ingredients?.length && !out.instructions?.length)) return null;
  return out;
}

/** First `itemprop=name` text (content attr for meta/time, else element text). */
function prop(scope: HTMLElement, name: string): string | undefined {
  const el = scope.querySelector(`[itemprop="${name}" i]`);
  return el ? elementValue(el) : undefined;
}

/** All `itemprop=name` values (for repeated props like ingredients/steps). */
function props(scope: HTMLElement, name: string): string[] {
  return scope
    .querySelectorAll(`[itemprop="${name}" i]`)
    .map(elementValue)
    .filter((s): s is string => !!s);
}

/** Prefer content/datetime attributes (used on <meta>/<time> for durations). */
function propAttr(scope: HTMLElement, name: string): string | undefined {
  const el = scope.querySelector(`[itemprop="${name}" i]`);
  if (!el) return undefined;
  return cleanText(el.getAttribute("content")) ?? cleanText(el.getAttribute("datetime")) ?? elementValue(el);
}

function imageProp(scope: HTMLElement, url: string): string | undefined {
  const el = scope.querySelector('[itemprop="image" i]');
  if (!el) return undefined;
  return absoluteUrl(url, el.getAttribute("src") ?? el.getAttribute("content") ?? el.getAttribute("href") ?? el.text);
}

function elementValue(el: HTMLElement): string | undefined {
  const tag = el.tagName?.toLowerCase();
  if (tag === "meta") return cleanText(el.getAttribute("content"));
  if (tag === "time") return cleanText(el.getAttribute("datetime")) ?? cleanText(el.text);
  if (tag === "img") return cleanText(el.getAttribute("src"));
  return cleanText(el.text);
}
