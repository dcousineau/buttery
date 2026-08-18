/**
 * `useActiveHouseholdId()` — the cache partition, as a hook (offline plan §4.1).
 *
 * Every household-scoped query key starts with this id, so it has to be
 * available everywhere a query is, it has to be the *same* value everywhere (two
 * spellings would silently split the cache in two), and — the part that makes it
 * more than a one-liner — **it has to survive being offline**.
 *
 * `authClient.useSession()` is a network read. On a phone in a store it resolves
 * to nothing, and a null household id would make every cached key unreachable:
 * the rows would be sitting in IndexedDB under `["household", "hh_123", …]`
 * while the app asked for `["household", null, …]`. So the live session is
 * preferred and the persisted snapshot (§4.4) is the fallback, which is exactly
 * the arrangement that makes an installed app open to a readable shopping list
 * in airplane mode.
 *
 * The snapshot is written here, on every successful live read, rather than in a
 * dedicated effect elsewhere — one hook owns both directions so they cannot
 * disagree about the shape.
 *
 * **"No live session" is two different situations and this module refuses to
 * conflate them** (see {@link SessionStatus}). Falling back to the snapshot
 * whenever `did` was missing meant a signed-out visitor was served the previous
 * user's handle, avatar and household id out of localStorage — indistinguishable,
 * from the outside, from them still being signed in. That is the §2.7 leak, and
 * it survived for the snapshot's full fourteen-day TTL.
 */

import { useEffect } from "react";
import { isSessionExpired } from "#/lib/api";
import { useHydratedSession } from "#/lib/auth-client";
import { useHydrated } from "#/lib/hooks/use-hydrated";
import { cacheSession, readCachedSession, type SessionSnapshot } from "./session-cache";

/**
 * How much the app actually knows about who is here.
 *
 * - `pending` — nothing yet: pre-hydration, or the session fetch is in flight.
 *   Chrome renders its signed-in-shaped skeleton against the snapshot; nothing
 *   destructive may act on this.
 * - `live` — the server answered with a user. The only status that may be
 *   *remembered* as the current partition.
 * - `stale` — the fetch failed, or failed to happen, so the snapshot stands in.
 *   This is the state where "no session" must never be read as "signed out":
 *   wiping here would delete the cache in the exact situation the cache exists
 *   for. Anything ambiguous lands here, deliberately.
 * - `signed-out` — the server answered, and answered *nobody*. This is the only
 *   negative answer strong enough to drop the snapshot and trigger a wipe.
 */
export type SessionStatus = "pending" | "live" | "stale" | "signed-out";

export interface SessionState {
  status: SessionStatus;
  /** `null` whenever there is genuinely nothing to show — never a stale identity. */
  snapshot: SessionSnapshot | null;
}

/**
 * The active household, live-first and snapshot-second. `null` for a signed-out
 * visitor, and on the very first render before hydration (`useHydratedSession`
 * reports pending until then, by design — see its docs).
 */
export function useActiveHouseholdId(): string | null {
  return useSessionSnapshot()?.activeHouseholdId ?? null;
}

/**
 * The chrome-facing session: DID, handle, name, active household — live when the
 * network answered, last-known-good when it could not, and **nothing at all when
 * the server says there is no session**.
 *
 * Callers must treat a snapshot exactly as they treat the live value: as a label
 * and a cache partition, never as authorization. Nothing here is a credential
 * and nothing here is checked by anything but the UI (§4.4).
 */
export function useSessionSnapshot(): SessionSnapshot | null {
  return useSessionState().snapshot;
}

/**
 * The snapshot plus the confidence behind it. Chrome wants
 * {@link useSessionSnapshot}; `useCachePartition` wants this, because deciding to
 * *delete* a cache is only safe on a confirmed answer.
 */
export function useSessionState(): SessionState {
  const { data: session, isPending, error } = useHydratedSession();
  // The snapshot lives in localStorage, so reading it before hydration would
  // make the first client render disagree with the server's and cost the whole
  // subtree (see `useHydrated`). It is also a `createClientOnlyFn` read, which
  // throws outright on the server rather than quietly answering null.
  const hydrated = useHydrated();
  const did = session?.user.did ?? null;
  // better-auth types `session.session` from the server config; `active_household_id`
  // is our own additional field (see `lib/auth.ts`), so it is read structurally.
  const activeHouseholdId = (session?.session as { active_household_id?: string | null } | undefined)?.active_household_id ?? null;
  const handle = session?.user.handle ?? null;
  const name = session?.user.name ?? null;

  useEffect(() => {
    if (!did) return;
    cacheSession({ did, handle, name, activeHouseholdId });
  }, [did, handle, name, activeHouseholdId]);

  if (did) return { status: "live", snapshot: { did, handle, name, activeHouseholdId } };
  if (!hydrated) return { status: "pending", snapshot: null };
  // In flight. better-auth starts every session atom pending and fetches on
  // mount, so this is the ordinary first-paint state, not an error.
  if (isPending) return { status: "pending", snapshot: readCachedSession() };

  // What is left is a settled fetch that produced no user, and the whole
  // question is whether the *server* said so. `signed-out` is the answer that
  // deletes things, so it is granted only to the two shapes that unambiguously
  // mean it: a clean response carrying no session, and an explicit 401 /
  // redirect-to-login. A 500, a captive portal's HTML, a dropped connection —
  // none of those are a statement about who is signed in, and treating them as
  // one would wipe a working cache over a server hiccup (§2.1 cuts the other way
  // here: cheap to rebuild is not the same as free to destroy mid-shopping-trip).
  if (error == null) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return offline ? { status: "stale", snapshot: readCachedSession() } : { status: "signed-out", snapshot: null };
  }
  if (isSessionExpired(error)) return { status: "signed-out", snapshot: null };
  return { status: "stale", snapshot: readCachedSession() };
}
