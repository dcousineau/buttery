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
 */

import { useEffect } from "react";
import { useHydratedSession } from "#/lib/auth-client";
import { useHydrated } from "#/lib/hooks/use-hydrated";
import { cacheSession, readCachedSession, type SessionSnapshot } from "./session-cache";

/**
 * The active household, live-first and snapshot-second. `null` only for a
 * genuinely signed-out visitor, or on the very first render before hydration
 * (`useHydratedSession` reports pending until then, by design — see its docs).
 */
export function useActiveHouseholdId(): string | null {
  return useSessionSnapshot()?.activeHouseholdId ?? null;
}

/**
 * The chrome-facing session: DID, handle, name, active household — live when the
 * network answered, last-known-good when it did not.
 *
 * Callers must treat a snapshot exactly as they treat the live value: as a label
 * and a cache partition, never as authorization. Nothing here is a credential
 * and nothing here is checked by anything but the UI (§4.4).
 */
export function useSessionSnapshot(): SessionSnapshot | null {
  const { data: session } = useHydratedSession();
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

  if (did) return { did, handle, name, activeHouseholdId };
  return hydrated ? readCachedSession() : null;
}
