/**
 * The query persister (offline plan §4.5).
 *
 * Per-query persistence (`experimental_createQueryPersister` on
 * `defaultOptions.queries.persister`) rather than whole-cache
 * `persistQueryClient`, for three reasons the plan spells out:
 *
 * - it restores lazily, per query, instead of blocking first paint on one large
 *   blob — a 300-recipe box is not something to deserialize before rendering the
 *   shopping list;
 * - it does not fight SSR hydration, because each query restores on its own
 *   first observer rather than replacing the dehydrated client wholesale;
 * - it does not rewrite the whole cache on every cache touch.
 *
 * The persister is **rebuilt whenever the partition changes**, because `buster`
 * is baked in at construction. `setPartition` swaps it on the live QueryClient,
 * which is what makes a household switch invalidate the store by construction
 * (§2.4) rather than by remembering to clean up.
 */

import { experimental_createQueryPersister } from "@tanstack/react-query-persist-client";
import type { QueryClient } from "@tanstack/react-query";
import { busterFor, type CachePartition } from "./partition";
import { readQueryEntry, removeQueryEntry, writeQueryEntry } from "./idb";

/** Two weeks. Long enough to survive a holiday; short enough to be a cache. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * `AsyncStorage`, backed by the guarded IndexedDB helpers. Values are strings —
 * the persister does its own JSON serialization, and letting it keep that job
 * means the stored shape is Query's, documented and versioned by Query.
 */
const idbStorage = {
  getItem: (key: string) => readQueryEntry(key),
  setItem: (key: string, value: string) => writeQueryEntry(key, value),
  removeItem: (key: string) => removeQueryEntry(key),
};

/**
 * Build a persister for one partition.
 *
 * `storage: undefined` on the server is the documented SSR opt-out — the
 * persister then no-ops rather than reaching for an IndexedDB that does not
 * exist. The client-only guards inside `idb.ts` are the second line of that
 * defence, and they throw rather than lie.
 */
export function createPersister(partition: CachePartition | null) {
  return experimental_createQueryPersister({
    storage: typeof window === "undefined" ? undefined : idbStorage,
    maxAge: MAX_AGE_MS,
    buster: busterFor(partition),
    prefix: "bq",
  });
}

/**
 * Point the client's default persister at a (possibly new) partition.
 *
 * Called once the session resolves and again on every household switch. Setting
 * `defaultOptions.queries.persister` affects queries mounted from here on;
 * `wipeCachePartition` is what deals with the bytes already on disk, and the two
 * are always called together (`useCachePartition`).
 */
export function setPartition(queryClient: QueryClient, partition: CachePartition | null): void {
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, persister: createPersister(partition).persisterFn },
  });
}
