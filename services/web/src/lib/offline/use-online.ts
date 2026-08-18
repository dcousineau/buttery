/**
 * "Is the browser online?", as a hook, and the disabled-affordance rule that
 * hangs off it (offline plan §4.1: M1 writes are online-only).
 *
 * `navigator.onLine` is a famously weak signal — it answers "is there a network
 * interface up", not "can I reach Buttery", so it says `true` on a captive-portal
 * hotel wifi and on a phone holding one bar of nothing. That is fine for what it
 * is used for here, which is **disabling buttons**, not deciding whether to
 * send: a false `true` costs a failed request and a toast (the pre-existing
 * behaviour), while a false `false` would refuse a write that would have worked.
 * So it is deliberately optimistic. M2's `networkMode: "offlineFirst"` makes the
 * same judgement from the other side — attempt once regardless of the guess.
 *
 * SSR renders `true` and the first client render matches, so this never causes a
 * hydration mismatch; the real value arrives on the commit after, via the
 * `online`/`offline` events.
 */

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function useIsOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true, // server snapshot: assume online, so hydration matches
  );
}

/**
 * The copy every offline-disabled control uses, so the app says the same thing
 * everywhere rather than inventing a phrasing per button.
 */
export const OFFLINE_WRITE_HINT = "You're offline — this needs a connection";
