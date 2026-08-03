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
 * now via lex's branded `currentDatetimeString()`.
 *
 * `rkey` pins the record key. Buttery mints the recipe's ULID locally at draft
 * time (the stable `recipe.id`) and reuses it as the atproto rkey on publish, so
 * the id survives the private → public transition unchanged and the cron sync
 * reconciles onto the existing local row instead of inserting a duplicate. When
 * omitted the PDS generates a key.
 *
 * Returns the created record's `{ uri, cid, rev }` — `rev` (from the commit) is
 * needed to seed the cron's rev-guarded sync bookkeeping.
 */
export async function createRecipe(did: string, draft: NewRecipe, rkey?: string): Promise<{ uri: string; cid: string; rev: string | null }> {
  const now = currentDatetimeString();
  const client = await getUserRecipeClient(did);
  const res = await client.create(
    recipe,
    {
      ...draft,
      createdAt: draft.createdAt ?? now,
      updatedAt: draft.updatedAt ?? now,
    },
    // `rkey` is optional for a tid-keyed record; InferRecordKey is branded, so a
    // plain ULID string needs the cast.
    rkey ? { rkey: rkey as never } : ({} as never),
  );
  return { uri: res.uri, cid: res.cid, rev: res.commit?.rev ?? null };
}

/**
 * Upload image bytes to the signed-in user's PDS as an atproto blob, returning
 * the blob ref for `record.embed.images[0].image`. Enforces the lexicon's
 * `image/*` + ≤1MB (`maxSize`) constraints before spending a network round-trip.
 */
export async function uploadRecipeImage(did: string, bytes: Uint8Array, mime: string) {
  if (!mime.startsWith("image/")) throw new Error("Recipe image must be an image/* file.");
  if (bytes.byteLength > 1_000_000) throw new Error("Recipe image must be 1 MB or smaller.");
  const client = await getUserRecipeClient(did);
  const res = await client.uploadBlob(bytes, { encoding: mime as `${string}/${string}` });
  return res.body.blob;
}
