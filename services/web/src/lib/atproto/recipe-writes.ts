import { Client, currentDatetimeString } from "@atproto/lex";
import recipe from "@buttery/lexicons/exchange/recipe/recipe";
import type { Main as RecipeRecord } from "@buttery/lexicons/exchange/recipe/recipe";
import { getAtprotoOAuthClient } from "./oauth-node";

/**
 * Fields for a new exchange.recipe.recipe record. Derived from the generated
 * lexicon type so a schema change surfaces here as a compile error. `$type` is
 * stamped by `Client.create`; the timestamps are defaulted by `createRecipe`,
 * so callers may omit them (pass a branded `currentDatetimeString()` /
 * `asDatetimeString(...)` to override).
 */
export type NewRecipe = Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt"> & Partial<Pick<RecipeRecord, "createdAt" | "updatedAt">>;

/**
 * Authenticated lex Client bound to a signed-in atproto user's PDS session.
 *
 * `restore` rehydrates the stored OAuth (DPoP) session for the DID; the
 * resulting OAuthSession already satisfies lex's `Agent` shape
 * (`{ did, fetchHandler }`), so it drops straight into `Client`. Server-only —
 * the DPoP keys never leave this process.
 */
export async function getUserRecipeClient(did: string) {
  const session = await getAtprotoOAuthClient().restore(did);
  return new Client(session);
}

/**
 * Create a recipe record in the signed-in user's repo. Timestamps default to
 * now via lex's branded `currentDatetimeString()`. Return type left inferred
 * (lex's `{ uri, cid }` create output) so a client change is caught at the
 * call sites.
 */
export async function createRecipe(did: string, draft: NewRecipe) {
  const now = currentDatetimeString();
  const client = await getUserRecipeClient(did);
  return client.create(recipe, {
    ...draft,
    createdAt: draft.createdAt ?? now,
    updatedAt: draft.updatedAt ?? now,
  });
}
