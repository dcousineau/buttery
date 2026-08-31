/**
 * The URL a not-yet-published recipe's photo renders from.
 *
 * Buttery serves recipe images from exactly two places, and this is the second
 * of them:
 *
 *   1. an atproto CDN, for a published recipe — the author's own bytes as a
 *      blob on their own PDS (`lib/atproto/images.ts`, `blobImageUrl`);
 *   2. **here** — our own object storage, proxied through
 *      `/api/recipe-image/:recipeId`, for everything before that.
 *
 * There is no third. An image URL on someone else's host is a place we read
 * bytes from once, never a thing we store or render; see
 * `src/server/recipe-images.ts` for the write side of the same rule.
 *
 * Client-safe: a string, built from an id the caller already has. The route it
 * points at does the authorization (the recipe must be in the caller's active
 * household) and the bucket read, so this file needs neither.
 */

/**
 * @param recipeId the local recipe's id — a ULID we minted, and also its atproto
 *                 rkey. Percent-encoded because rkeys legitimately contain `.`,
 *                 `:` and `~`, and an id is never shape-validated in this repo.
 */
export function pendingImageUrl(recipeId: string): string {
  return `/api/recipe-image/${encodeURIComponent(recipeId)}`;
}
