/**
 * Keeps the on-disk cache pointed at exactly one `(did, householdId)` — and
 * throws the previous one away the moment it stops being current (offline plan
 * §2.7, §4.5).
 *
 * Mounted once, at the root. Two things happen here and they are deliberately
 * not separable:
 *
 * 1. **Re-point the persister.** `buster` is baked into a persister at
 *    construction, so a household switch needs a new one. Entries written under
 *    the old buster stop matching on read, which is the "by construction" half of
 *    §2.4 — no code has to remember to invalidate them.
 * 2. **Wipe what is already on disk.** The buster alone would leave the previous
 *    household's bytes in IndexedDB until each entry happened to be read again.
 *    On a shared family iPad, "eventually" is not a privacy answer.
 *
 * The in-memory cache is cleared alongside the disk one: a `QueryClient` that
 * outlives a household switch would otherwise keep serving the old household's
 * rows to `useSuspenseQuery` from RAM, with the disk perfectly clean.
 *
 * **Two rules govern the wipe branch, and both were learned the hard way:**
 *
 * - *The previous partition is read from disk, not from a ref.* Every identity
 *   change in this app crosses a full document load — sign-out hard-navigates,
 *   sign-in returns from the atproto redirect — so a `useRef` seeded with `null`
 *   is guaranteed to be empty on precisely the run that would have to notice one.
 *   `readLastPartition()` is the half of the comparison that survives the reload.
 * - *Only a confirmed identity may act.* `stale` (offline) and `pending`
 *   (in-flight) both look exactly like "signed out" from the outside, and acting
 *   on either would wipe the cache of an offline user — deleting the shopping
 *   list this whole feature exists to keep readable in a store.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { requestPersistentStorage } from "./idb";
import { persistHydratedQueries, setPartition, watchForHydratedQueries } from "./persister";
import { useSessionState } from "./use-household";
import { readLastPartition, rememberPartition } from "./session-cache";
import { wipeCachePartition } from "./partition";

/** `null` for a signed-out or household-less visitor: nothing to partition. */
function partitionKey(did: string | null, householdId: string | null): string | null {
  return did && householdId ? `${did}:${householdId}` : null;
}

export function useCachePartition(): void {
  // The client comes from the router's context, not from `useQueryClient()`.
  // This hook is mounted in the root route's `shellComponent`, which renders the
  // document itself — outside the `QueryClientProvider` that
  // `setupRouterSsrQueryIntegration` installs via `router.options.Wrap`. The
  // router context is available everywhere under the provider *and* above it,
  // and it is the same client either way (`getRouter` constructs exactly one).
  const queryClient = useRouter().options.context.queryClient;
  const { status, snapshot } = useSessionState();
  const did = snapshot?.did ?? null;
  const householdId = snapshot?.activeHouseholdId ?? null;
  // `undefined` until the effect has run once; `null` is a real value here (the
  // signed-out partition), so the two cannot share a sentinel.
  const installed = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const key = partitionKey(did, householdId);
    // Only an answer from the server may be compared against, remembered, or
    // acted on. Offline and in-flight are indistinguishable from signed-out here,
    // and guessing wrong costs a user the offline cache they are standing in a
    // shop relying on.
    const confirmed = status === "live" || status === "signed-out";
    const last = confirmed ? readLastPartition() : null;
    const identityChanged = confirmed && last !== null && last !== key;
    // `pending` is the one status that must not install anything. Its key is
    // `null` only because nobody has answered yet, and installing the anon
    // persister there would file the household rows SSR just hydrated under the
    // `v1:anon` buster — writing household data to a partition that is meant to
    // hold none. Every other status has a real answer behind its key, `stale`
    // included: an offline cold start's whole job is to serve that partition.
    const repoint = status !== "pending" && installed.current !== key;

    // Install the persister for whatever partition this is, including the `null`
    // one a confirmed signed-out visitor gets. That visitor used to get no
    // persister at all — the guard was `previous.current === key`, and on the
    // first run both sides were `null` — which also left
    // `watchForHydratedQueries` writing through a persister that did not exist,
    // permanently, for every anonymous visit.
    if (repoint) {
      installed.current = key;
      setPartition(queryClient, did && householdId ? { did, householdId } : null);
    }
    if (confirmed) rememberPartition(key);

    if (identityChanged) {
      // A sign-out, a second person signing in on the family iPad, or a
      // household switch. The old partition's bytes go now rather than whenever
      // each entry is next read (§2.7 — "eventually" is not a privacy answer).
      //
      // Which of the three it is decides how much goes: only a same-person
      // household switch may keep the identity snapshots. `startsWith` rather
      // than a split on ":" because a DID contains colons of its own
      // (`did:plc:…`), so the household id is not the second field.
      const samePerson = did !== null && last !== null && last.startsWith(`${did}:`);
      queryClient.clear();
      // Re-arm the tripwire afterwards. A wipe that is not a household switch
      // takes the marker with it — it names the *previous* person's DID, so a
      // sign-out must not leave it behind — and the marker is what lets the next
      // handover be noticed. Without this, someone who signs in, is wiped, and
      // hands the phone straight on leaves a partition nothing will compare
      // against, which is the §2.7 leak one person further down the chain.
      void wipeCachePartition(key === null ? "sign-out" : samePerson ? "household-switch" : "identity-change").then(() => {
        if (key !== null) rememberPartition(key);
        // The wipe raced navigation: the new persister was live from the moment
        // `setPartition` ran above, so anything the new partition fetched while
        // `clearQueryStore()` was in flight got written to disk and then deleted
        // by it. RAM still holds those rows — re-file them. (This is safe here
        // and unsafe before the wipe for the same reason: what matters is whose
        // rows are in memory, and after `queryClient.clear()` they are all the
        // new partition's.)
        persistHydratedQueries(queryClient);
      });
      return;
    }

    // Whatever SSR already put in the cache has never been through the persister
    // — see `persistHydratedQueries` for why that is not obvious. It runs only
    // on the *non*-switch path, and the ordering is load-bearing: at switch time
    // the in-memory cache still holds the OLD household's rows, and persisting
    // them through the freshly re-pointed persister would file household A's
    // recipes under household B's buster. That is the §2.4 leak, written by the
    // very code meant to prevent it.
    if (repoint) persistHydratedQueries(queryClient);
  }, [queryClient, did, householdId, status]);

  useEffect(() => watchForHydratedQueries(queryClient), [queryClient]);

  useEffect(() => {
    // Once per app load, best-effort. Chrome may grant it for an installed app;
    // Safari will not, and nothing here branches on the answer (§9.2).
    void requestPersistentStorage();
  }, []);
}
