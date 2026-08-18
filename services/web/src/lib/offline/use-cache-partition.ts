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
 */

import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { requestPersistentStorage } from "./idb";
import { setPartition } from "./persister";
import { useSessionSnapshot } from "./use-household";
import { wipeCachePartition } from "./partition";

export function useCachePartition(): void {
  // The client comes from the router's context, not from `useQueryClient()`.
  // This hook is mounted in the root route's `shellComponent`, which renders the
  // document itself — outside the `QueryClientProvider` that
  // `setupRouterSsrQueryIntegration` installs via `router.options.Wrap`. The
  // router context is available everywhere under the provider *and* above it,
  // and it is the same client either way (`getRouter` constructs exactly one).
  const queryClient = useRouter().options.context.queryClient;
  const session = useSessionSnapshot();
  const did = session?.did ?? null;
  const householdId = session?.activeHouseholdId ?? null;
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const key = did && householdId ? `${did}:${householdId}` : null;
    if (previous.current === key) return;

    // The first run of this effect is not a switch — it is the app learning who
    // is signed in. Wiping there would throw away the cache we just restored
    // from, on every single cold start, which is the opposite of the feature.
    const isSwitch = previous.current !== null;
    previous.current = key;

    setPartition(queryClient, did && householdId ? { did, householdId } : null);

    if (isSwitch) {
      queryClient.clear();
      void wipeCachePartition(key === null ? "sign-out" : "household-switch");
    }
  }, [queryClient, did, householdId]);

  useEffect(() => {
    // Once per app load, best-effort. Chrome may grant it for an installed app;
    // Safari will not, and nothing here branches on the answer (§9.2).
    void requestPersistentStorage();
  }, []);
}
