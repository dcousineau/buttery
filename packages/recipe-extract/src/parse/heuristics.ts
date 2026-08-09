import type { ExtractedRecipe, ParsedInput } from "../types.ts";
import { absoluteUrl, cleanText } from "@buttery/recipe-schemas/normalize";

/**
 * Last-resort coarse heuristics. Deliberately shallow: reliably guessing which
 * list on an arbitrary page is "the ingredients" is a losing game and produces
 * garbage more often than help. So we only pull the safe, high-signal bits —
 * title and hero image from OpenGraph / `<h1>` / meta description — enough to
 * seed the form so the user finishes by hand. Ingredients/instructions are left
 * empty on purpose (a wrong guess is worse than a blank the user fills in).
 */
export function fromHeuristics({ root, url }: ParsedInput): ExtractedRecipe | null {
  const out: ExtractedRecipe = {};

  const name = meta(root, 'meta[property="og:title"]') ?? cleanText(root.querySelector("h1")?.text) ?? meta(root, "title");
  if (name) out.name = name;

  const text = meta(root, 'meta[property="og:description"]') ?? meta(root, 'meta[name="description"]');
  if (text) out.text = text;

  const rawImage = attr(root, 'meta[property="og:image"]', "content") ?? attr(root, 'meta[name="twitter:image"]', "content") ?? attr(root, 'link[rel="image_src"]', "href");
  const image = absoluteUrl(url, rawImage);
  if (image) out.imageUrl = image;

  return out.name || out.imageUrl ? out : null;
}

function meta(root: ParsedInput["root"], selector: string): string | undefined {
  const el = root.querySelector(selector);
  if (!el) return undefined;
  return cleanText(el.getAttribute("content")) ?? cleanText(el.text);
}

function attr(root: ParsedInput["root"], selector: string, name: string): string | undefined {
  return cleanText(root.querySelector(selector)?.getAttribute(name));
}
