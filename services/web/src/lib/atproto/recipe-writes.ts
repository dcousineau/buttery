import { Client, currentDatetimeString } from "@atproto/lex";
import recipe from "@buttery/lexicons/exchange/recipe/recipe";
import type { Main as RecipeRecord } from "@buttery/lexicons/exchange/recipe/recipe";
import { getAtprotoOAuthClient } from "./oauth-node";

/**
 * Thrown when the PDS rejects a write because the stored OAuth grant predates
 * (or is narrower than) the scopes in `ATPROTO_SCOPE`. Not recoverable
 * server-side: a refresh token carries its original scope, so the only fix is
 * sending the user back through the authorization flow.
 */
export class AtprotoScopeError extends Error {
  /** The scope the PDS said was missing, e.g. `blob:image/jpeg`. */
  readonly missingScope: string | null;
  constructor(missingScope: string | null) {
    super(missingScope ? `atproto grant is missing the "${missingScope}" scope` : "atproto grant is missing a required scope");
    this.name = "AtprotoScopeError";
    this.missingScope = missingScope;
  }
}

/**
 * Recognize the PDS's 403 for an under-scoped grant. The message shape comes
 * from `ScopeMissingError` in @atproto/oauth-scopes (`Missing required scope
 * "<scope>"`); we match on it rather than on status or an error code, because
 * 403 covers plenty of unrelated refusals (blocked, takedown, rate limit) and
 * the code the PDS surfaces isn't specific to this case. Matching the message
 * also hands us the exact missing scope to name in the re-auth prompt.
 */
function asScopeError(err: unknown): AtprotoScopeError | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /Missing required scope "([^"]*)"/.exec(message);
  return match ? new AtprotoScopeError(match[1] || null) : null;
}

/** Run a PDS write, converting an under-scoped 403 into `AtprotoScopeError`. */
export async function withScopeCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const scopeErr = asScopeError(err);
    if (scopeErr) throw scopeErr;
    throw err;
  }
}

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
 * That is why `exchange.recipe.recipe` declares `"key": "any"` rather than the
 * more common `"tid"`: a ULID is 26 chars of Crockford base32, which is a valid
 * record key but *not* a valid TID, so a tid-keyed lexicon rejects it outright
 * (`Invalid TID string`). `any` is a strict widening — TIDs remain valid — so
 * any record already written under the old declaration still validates.
 *
 * Returns the created record's `{ uri, cid, rev }` — `rev` (from the commit) is
 * needed to seed the cron's rev-guarded sync bookkeeping.
 */
export async function createRecipe(did: string, draft: NewRecipe, rkey?: string): Promise<{ uri: string; cid: string; rev: string | null }> {
  const now = currentDatetimeString();
  const client = await getUserRecipeClient(did);
  const res = await withScopeCheck(() =>
    client.create(
      recipe,
      {
        ...draft,
        createdAt: draft.createdAt ?? now,
        updatedAt: draft.updatedAt ?? now,
      },
      rkey ? { rkey } : {},
    ),
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
  const res = await withScopeCheck(() => client.uploadBlob(bytes, { encoding: mime as `${string}/${string}` }));
  return res.body.blob;
}
