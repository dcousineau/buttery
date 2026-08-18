/**
 * The cache partition — which household's rows the local copy currently holds,
 * and how it is thrown away (offline plan §2.4, §2.7, §4.5).
 *
 * Two rules do all the work here:
 *
 * 1. **The server is truth; the local copy is disposable (§2.1).** Every byte in
 *    IndexedDB is reconstructible from the server, so discarding is always safe
 *    and is always the answer when anything is in doubt. Nothing here migrates.
 * 2. **Household is the minimum privacy scope (§2.7).** A shared family iPad must
 *    not leak one household's box into another's, so the partition key is
 *    `(did, householdId)` and it is folded into the persister's `buster` — a
 *    household switch therefore invalidates the whole store *by construction*
 *    rather than by remembering to call a cleanup function.
 *
 * The versioned-discard idiom is lifted from `COOK_STATE_VERSION`
 * (`useCookPersistence.ts`): bump the number, mismatched payloads are dropped,
 * never migrated.
 */

import { createClientOnlyFn } from "@tanstack/react-start";
import { clearQueryStore } from "./idb";
import { clearOfflineFallbacks } from "./session-cache";

/**
 * Bump on ANY breaking change to a cached wire DTO in `src/lib/api/types.ts`.
 *
 * A field being added is usually not breaking (an older payload just lacks it,
 * and the components already tolerate that for `plannedUsage`). A field changing
 * meaning, type, or units is. When unsure, bump — the cost is one cold refetch
 * per user, and the alternative is a phone rendering last month's shape.
 */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * Why the partition was thrown away. Reported as `cache_partition_wiped {reason}`.
 *
 * `identity-change` is not in §4.5's list because §4.5 assumed sign-out was the
 * only way to stop being one person and start being another. It is not: signing
 * in as someone else without signing out first is one document load, and on a
 * shared device it is the *likely* path. It wipes as hard as a sign-out does —
 * only `household-switch` is narrower (same person, same snapshots).
 */
export type WipeReason = "sign-out" | "identity-change" | "household-switch" | "forbidden" | "schema-version" | "quota";

/**
 * The identity a cached payload belongs to. `null` for a signed-out or
 * household-less visitor, who has nothing cacheable in the first place.
 */
export interface CachePartition {
  did: string;
  householdId: string;
}

/**
 * The persister's `buster`. Folding the schema version AND the partition into
 * one string means a household switch and a DTO change are the same event as far
 * as the store is concerned: the entries written under the old buster stop
 * matching and are discarded on read.
 *
 * That is belt; `wipeCachePartition` is braces. The buster alone would leave the
 * old household's bytes on disk until each entry was next read, which is a
 * privacy answer of "eventually" — not good enough for §2.7 on a shared device.
 */
export function busterFor(partition: CachePartition | null): string {
  if (!partition) return `v${CACHE_SCHEMA_VERSION}:anon`;
  return `v${CACHE_SCHEMA_VERSION}:${partition.did}:${partition.householdId}`;
}

/**
 * The service worker's recipe-image bucket (`src/sw.ts`, `IMAGE_CACHE`).
 *
 * Matched by prefix rather than by importing the constant: `sw.ts` compiles in
 * its own build (`tsconfig.sw.json`) and versions its bucket name, so a prefix is
 * the one seam that survives both sides moving.
 *
 * The `buttery-shell-*` precache is deliberately **not** matched. It holds the
 * app's own JS/CSS/HTML and no user data, and dropping it would make every
 * household switch re-download a hundred-odd assets — an offline-hostile cost for
 * zero privacy gain (§2.2: the SW caches the app, Query caches the data).
 */
const IMAGE_CACHE_PREFIX = "buttery-images-";

/**
 * Cache Storage is the *third* place user data lands, and the one that is easy to
 * forget because nothing in the Query stack ever touches it: the SW caches recipe
 * hero images from the bsky CDN (§4.4, §4.6), keyed by URL. Those URLs are
 * household content. A wipe that cleared IndexedDB and localStorage but left them
 * behind still leaves the previous household's photos on the disk of a shared
 * iPad, retrievable by anyone who can get the app to request that URL.
 */
async function clearImageCaches(): Promise<void> {
  // Undefined in an insecure context, and known to throw on property access in
  // some private-browsing modes — hence the guard *and* the caller's allSettled.
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(IMAGE_CACHE_PREFIX)).map((name) => caches.delete(name)));
}

/**
 * Drop everything cached for the current partition.
 *
 * Called on sign-out, household switch, and any membership failure from the
 * server (§4.5). Deliberately clears the *whole* query store rather than the
 * entries matching one buster: at wipe time the thing being protected against is
 * precisely a wrong idea of which partition is current, so "delete all of it" is
 * the only version that cannot be wrong. Everything is refetchable (§2.1).
 *
 * **The reason matters for the localStorage snapshots, and only for those.** A
 * household switch is the one wipe that runs *while the identity is being
 * rewritten*: `useSessionSnapshot` caches the new household's snapshot the moment
 * the session reports it, which is a render before this promise resolves. Wiping
 * the fallbacks here therefore deleted the snapshot belonging to the household
 * being switched **to**, leaving the app less offline-capable straight after a
 * switch than before it. Every other reason — sign-out, a different person
 * signing in, `forbidden`, a schema bump — invalidates the identity itself, so
 * those clear the lot.
 *
 * Best-effort and never throwing: `signOutAndGoHome` awaits this *before* it
 * redirects, and a rejection that skipped the redirect would strand a signed-out
 * user on an authed screen. Nothing in here is allowed to reject.
 */
export const wipeCachePartition = createClientOnlyFn(async (reason: WipeReason): Promise<void> => {
  // A store we cannot open holds nothing we can leak; either way the caller
  // proceeds. `allSettled` so one failing bucket cannot skip the other.
  await Promise.allSettled([clearQueryStore(), clearImageCaches()]);

  if (reason !== "household-switch") {
    try {
      clearOfflineFallbacks();
    } catch {
      // localStorage can throw in private mode. Not a reason to stay put.
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("buttery:cache-wiped", { detail: { reason } }));
  }
});
