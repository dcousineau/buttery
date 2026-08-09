import type { HTMLElement } from "node-html-parser";
import type { HRecipeProperty, RawHRecipe } from "@buttery/recipe-schemas/hrecipe";
import { HRECIPE_PROPERTY_CLASSES, HRECIPE_ROOT_CLASSES, HRECIPE_VALUE_CLASSES } from "@buttery/recipe-schemas/hrecipe";
import { hRecipeToLexicon } from "@buttery/recipe-schemas/bridge";
import type { ExtractedRecipe, ParsedInput } from "../types.ts";

/**
 * microformats hRecipe (mf1) / h-recipe (mf2) — https://microformats.org/wiki/hrecipe.
 *
 * Runs after the schema.org paths: hRecipe carries strictly less (no diets, no
 * structured nutrition, no controlled vocabularies), so it's only ever the best
 * source on pages that ship nothing else. Plenty of older food blogs do.
 *
 * Like the other parsers this only reads the DOM — which class names mean what,
 * and what the values become, lives in `@buttery/recipe-schemas/hrecipe`.
 */
export function fromHRecipe({ root, url }: ParsedInput): ExtractedRecipe | null {
  const scope = findRoot(root);
  if (!scope) return null;

  const raw: RawHRecipe = {};
  for (const property of Object.keys(HRECIPE_PROPERTY_CLASSES) as HRecipeProperty[]) {
    const values = collect(scope, property);
    if (values.length) raw[property] = values;
  }

  const recipe = hRecipeToLexicon(raw, url);
  // Same bar as microdata: a name plus a body, else fall through to heuristics.
  if (!recipe.name || (!recipe.ingredients?.length && !recipe.instructions?.length)) return null;
  return recipe;
}

/** The first `.h-recipe` / `.hrecipe` subtree on the page. */
function findRoot(root: HTMLElement): HTMLElement | null {
  for (const cls of HRECIPE_ROOT_CLASSES) {
    const el = root.querySelector(`.${cls}`);
    if (el) return el;
  }
  return null;
}

/**
 * Values for one property, in document order. Nested h-recipes (a page listing
 * several recipes) are skipped so we don't blend two recipes together.
 */
function collect(scope: HTMLElement, property: HRecipeProperty): string[] {
  const out: string[] = [];
  const seen = new Set<HTMLElement>();
  for (const cls of HRECIPE_PROPERTY_CLASSES[property]) {
    for (const el of scope.querySelectorAll(`.${cls}`)) {
      if (seen.has(el) || belongsToNestedRecipe(el, scope)) continue;
      seen.add(el);
      const value = propertyValue(el, cls, property);
      if (value) out.push(value);
    }
  }
  return out;
}

function belongsToNestedRecipe(el: HTMLElement, scope: HTMLElement): boolean {
  let parent: HTMLElement | null = el.parentNode;
  while (parent && parent !== scope) {
    if (HRECIPE_ROOT_CLASSES.some((c) => hasClass(parent as HTMLElement, c))) return true;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * Microformats put the machine-readable value in different places depending on
 * the prefix: `u-*` is a URL attribute, `dt-*` a datetime, `e-*` the element's
 * markup (we take its text), `p-*` its text. mf1 has no prefixes, so it leans on
 * the `value-title` pattern instead — a nested element carrying the real value
 * in a `title` attribute while the visible text stays human-friendly.
 */
function propertyValue(el: HTMLElement, cls: string, property: HRecipeProperty): string | undefined {
  const valued = valuePattern(el);
  if (valued) return valued;

  // URL-ish: `u-*` in mf2, bare `photo` in mf1.
  if (cls.startsWith("u-") || cls === "photo") {
    return trimmed(el.getAttribute("href")) ?? trimmed(el.getAttribute("src")) ?? trimmed(el.getAttribute("data")) ?? trimmed(el.text);
  }
  // Date/duration-ish: `dt-*` in mf2, bare `duration`/`published` in mf1.
  if (cls.startsWith("dt-") || cls === "duration" || cls === "published") {
    return trimmed(el.getAttribute("datetime")) ?? trimmed(el.getAttribute("title")) ?? trimmed(el.text);
  }
  // hRecipe puts the whole method in ONE element, so its internal list markup is
  // the only thing separating the steps. Flatten it to lines the coercion splits.
  if (property === "instructions") return blockText(el);

  return trimmed(el.text);
}

/** Text of an element's block children as lines, or its own text if it has none. */
function blockText(el: HTMLElement): string | undefined {
  const blocks = el.querySelectorAll("li, p");
  if (!blocks.length) return multiline(el.text);
  const lines = blocks.map((b) => trimmed(b.text)).filter((s): s is string => !!s);
  return lines.length ? lines.join("\n") : multiline(el.text);
}

/** Like `trimmed`, but keeps line breaks — they're the step separators. */
function multiline(v: string | undefined): string | undefined {
  const s = (v ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s ? s : undefined;
}

/** mf1 `value-title` / `value` pattern, if this element uses it. */
function valuePattern(el: HTMLElement): string | undefined {
  for (const cls of HRECIPE_VALUE_CLASSES) {
    const inner = el.querySelector(`.${cls}`);
    if (!inner) continue;
    const value = cls === "value-title" ? inner.getAttribute("title") : inner.text;
    const s = trimmed(value);
    if (s) return s;
  }
  return undefined;
}

function hasClass(el: HTMLElement, cls: string): boolean {
  return el.classList?.contains(cls) ?? false;
}

function trimmed(v: string | undefined): string | undefined {
  const s = v?.replace(/\s+/g, " ").trim();
  return s ? s : undefined;
}
