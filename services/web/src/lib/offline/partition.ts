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

/**
 * Bump on ANY breaking change to a cached wire DTO in `src/lib/api/types.ts`.
 *
 * A field being added is usually not breaking (an older payload just lacks it,
 * and the components already tolerate that for `plannedUsage`). A field changing
 * meaning, type, or units is. When unsure, bump — the cost is one cold refetch
 * per user, and the alternative is a phone rendering last month's shape.
 */
export const CACHE_SCHEMA_VERSION = 1;

/** Why the partition was thrown away. Reported as `cache_partition_wiped {reason}`. */
export type WipeReason = "sign-out" | "household-switch" | "forbidden" | "schema-version" | "quota";

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
 * Drop everything cached for the current partition.
 *
 * Called on sign-out, household switch, and any membership failure from the
 * server (§4.5). Deliberately clears the *whole* query store rather than the
 * entries matching one buster: at wipe time the thing being protected against is
 * precisely a wrong idea of which partition is current, so "delete all of it" is
 * the only version that cannot be wrong. Everything is refetchable (§2.1).
 *
 * Best-effort and never throwing: a failed wipe must not block a sign-out.
 */
export const wipeCachePartition = createClientOnlyFn(async (reason: WipeReason): Promise<void> => {
  try {
    await clearQueryStore();
  } catch {
    // A store we cannot open holds nothing we can leak. Sign-out proceeds.
  }
  // The gate/session fallbacks are separate keys with their own lifetime; the
  // session snapshot in particular must not outlive a sign-out.
  const { clearOfflineFallbacks } = await import("./session-cache");
  clearOfflineFallbacks();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("buttery:cache-wiped", { detail: { reason } }));
  }
});
