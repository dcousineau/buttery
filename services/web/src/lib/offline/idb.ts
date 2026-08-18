/**
 * The IndexedDB stores, and the quota discipline around them (offline plan §4.5).
 *
 * M1 opens exactly one store, `buttery-queries` — one entry per query, written by
 * `experimental_createQueryPersister`. M2 adds a second, `buttery-outbox`, whose
 * loss tolerance is *none*; keeping them in separate stores from day one is what
 * lets the quota handler below evict freely from one and never from the other.
 *
 * Every entry point goes through `createClientOnlyFn`, matching
 * `src/lib/timers/storage.ts`: a server-side read throws loudly instead of
 * silently returning nothing and teaching a caller that the cache is empty.
 *
 * **Writes never reject.** A persister that throws takes the query with it, and
 * an app that fails to *render* because it failed to *cache* has the tradeoff
 * exactly backwards — the server is truth (§2.1) and the cache is a bonus. So
 * `QuotaExceededError` is caught, reported once, and turned into an eviction
 * pass rather than an exception.
 */

import { createClientOnlyFn } from "@tanstack/react-start";
import { clear, createStore, del, entries, get, set, type UseStore } from "idb-keyval";

/** One entry per query, keyed `bq-<queryHash>` by the persister. */
const QUERY_DB = "buttery-queries";
const QUERY_STORE = "queries";

let store: UseStore | null = null;

function queryStore(): UseStore {
  store ??= createStore(QUERY_DB, QUERY_STORE);
  return store;
}

/** Fired once per session when the browser refuses a write. */
let quotaReported = false;

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

/**
 * Evict the oldest half of the query store.
 *
 * Half, not "just enough": eviction is itself several writes against a store
 * that has already refused one, and trimming one entry at a time under pressure
 * is how a quota problem becomes a stall. The evicted entries are refetched from
 * the server on next read, which is the whole point of §2.1.
 *
 * Ordering is by each entry's `state.dataUpdatedAt`, read back out of the stored
 * payload — `idb-keyval` has no metadata of its own to sort by.
 */
async function evictOldestHalf(): Promise<void> {
  const all = await entries<string, string>(queryStore());
  const dated = all.map(([key, value]) => {
    let timestamp = 0;
    try {
      // A persisted entry is `{ buster, queryHash, queryKey, state }`; the only
      // clock in it is the query state's own last-updated stamp.
      timestamp = (JSON.parse(value) as { state?: { dataUpdatedAt?: number } }).state?.dataUpdatedAt ?? 0;
    } catch {
      // Unparseable entries are the first thing worth losing.
    }
    return { key, timestamp };
  });
  dated.sort((a, b) => a.timestamp - b.timestamp);
  await Promise.all(dated.slice(0, Math.ceil(dated.length / 2)).map(({ key }) => del(key, queryStore()).catch(() => undefined)));
}

/** Read one persisted query entry. `undefined` on miss or on any storage failure. */
export const readQueryEntry = createClientOnlyFn(async (key: string): Promise<string | undefined> => {
  try {
    return await get<string>(key, queryStore());
  } catch {
    return undefined;
  }
});

/**
 * Write one persisted query entry, with the quota fallback described above.
 * Resolves either way — the caller is a persister, and its failure mode must not
 * become the query's.
 */
export const writeQueryEntry = createClientOnlyFn(async (key: string, value: string): Promise<void> => {
  try {
    await set(key, value, queryStore());
  } catch (error) {
    if (!isQuotaError(error)) return;
    if (!quotaReported) {
      quotaReported = true;
      window.dispatchEvent(new CustomEvent("buttery:idb-quota-exceeded", { detail: { store: QUERY_DB } }));
    }
    try {
      await evictOldestHalf();
      await set(key, value, queryStore());
    } catch {
      // Still no room. The query stays memory-only for this session.
    }
  }
});

/** Remove one persisted query entry. */
export const removeQueryEntry = createClientOnlyFn(async (key: string): Promise<void> => {
  try {
    await del(key, queryStore());
  } catch {
    /* nothing to remove is the same outcome as removing it */
  }
});

/** Empty the whole query store — the §4.5 wipe. */
export const clearQueryStore = createClientOnlyFn(async (): Promise<void> => {
  await clear(queryStore());
});

/**
 * Ask the browser to exempt this origin from eviction. Chrome may grant it for an
 * installed app; **Safari will not**, and the whole design is built so that it
 * does not matter (§9.2) — an evicted cache is a cold start, not data loss.
 * Called once, best-effort, and its answer is not branched on.
 */
export const requestPersistentStorage = createClientOnlyFn(async (): Promise<boolean> => {
  try {
    if (!navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
});
