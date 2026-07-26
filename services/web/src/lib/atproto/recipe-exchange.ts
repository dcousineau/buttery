import { createServerFn } from "@tanstack/react-start";
import { isComingSoon } from "../config";
import { RECIPE_COLLECTION } from "./recipes";

/** ULID — the rkey format recipe.exchange uses for recipe records */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const RECIPE_EXCHANGE_URL_RE = /^https?:\/\/(?:www\.)?recipe\.exchange\/recipes\/([0-9A-HJKMNP-TV-Z]{26})/i;

const AT_URI_RE = new RegExp(`at://[a-zA-Z0-9._:%-]+/${RECIPE_COLLECTION.replaceAll(".", "\\.")}/[0-9A-HJKMNP-TV-Z]{26}`, "i");

/**
 * A recipe.exchange URL only carries the record's rkey (a ULID) — not the
 * repo DID, so the AT-URI can't be derived locally. The recipe page embeds
 * the full at:// URI, so fetch it server-side (their site has no CORS
 * headers) and extract it.
 */
export const resolveRecipeExchangeId = createServerFn({ method: "GET" })
  .validator((id: string) => {
    if (typeof id !== "string" || !ULID_RE.test(id.trim())) {
      throw new Error("Not a valid recipe.exchange recipe id");
    }
    return id.trim().toUpperCase();
  })
  .handler(async ({ data: id }) => {
    if (await isComingSoon()) throw new Error("Recipe lookup is not available yet");
    const res = await fetch(`https://recipe.exchange/recipes/${id}`);
    if (!res.ok) {
      throw new Error(`recipe.exchange returned HTTP ${res.status} for ${id}`);
    }
    const html = await res.text();
    const match = AT_URI_RE.exec(html);
    if (!match) {
      throw new Error(`No AT-URI found on recipe.exchange page for ${id}`);
    }
    return match[0];
  });

/**
 * Normalize any accepted recipe reference into something fetchRecipe can
 * parse: full at:// URI and handle/rkey forms pass through; recipe.exchange
 * URLs and bare ULIDs resolve via the server function.
 */
export async function normalizeRecipeRef(input: string): Promise<string> {
  const trimmed = input.trim();
  const urlMatch = RECIPE_EXCHANGE_URL_RE.exec(trimmed);
  const id = urlMatch?.[1] ?? (ULID_RE.test(trimmed) ? trimmed : null);
  if (id) return resolveRecipeExchangeId({ data: id });
  return trimmed;
}
