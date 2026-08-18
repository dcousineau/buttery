import { createAuthClient } from "better-auth/react";
import { atprotoClient } from "./atproto/better-auth-client-plugin";
import { useHydrated } from "./hooks/use-hydrated";
import { wipeCachePartition } from "./offline/partition";

export const authClient = createAuthClient({
  plugins: [atprotoClient()],
});

/**
 * `authClient.useSession()`, but safe to render from.
 *
 * The raw hook is not: SSR has no session at all, while the browser's auth
 * store can answer from cache on the very first client render. Anything that
 * renders differently for a signed-in user therefore renders one way on the
 * server and another way during hydration, and React responds by throwing the
 * whole subtree away and logging an error — on every page load, for every
 * visitor who is signed in. It cost us the header twice over (the timer
 * indicator and the account menu) before it was traced.
 *
 * This reports "still pending" until hydration is done, so the first client
 * render matches the server's by construction and the real session arrives on
 * the commit after. **Prefer it over `authClient.useSession()` anywhere the
 * answer reaches the DOM.** Effects can use either — they only run in the
 * browser, where the two agree.
 */
export function useHydratedSession(): ReturnType<typeof authClient.useSession> {
  const session = authClient.useSession();
  const hydrated = useHydrated();
  return hydrated ? session : { ...session, data: null, isPending: true };
}

/**
 * Re-read the session from the server and push it into better-auth's client
 * store, so `useSession()` — and everything partitioned by it — sees the change.
 *
 * Needed because Buttery mutates the session **outside** better-auth: the active
 * household lives in our own `session.active_household_id` column and is written
 * by plain server functions (`switchActiveHousehold`, `createHousehold`,
 * `acceptInvite`). better-auth only refetches its store after its *own*
 * endpoints, so without this the client keeps the old household id until some
 * later window focus or poll happens to refresh it — and in the meantime the
 * cache partition, and therefore the persister's `buster`, still points at the
 * previous household. The mirror then writes the new household's recipes to disk
 * under the old household's buster, where they are discarded on the next read
 * (§2.4, §4.5): a switch that silently costs the user their offline copy.
 *
 * Awaiting the store's own `refetch` (rather than firing `$store.notify`, which
 * returns nothing to wait on) is what lets a caller navigate *after* the app
 * agrees about which household it is in.
 */
export async function refreshSession(): Promise<void> {
  // `$store.atoms` is typed `Record<string, WritableAtom<any>>`, so the shape is
  // asserted here rather than reached for at each call site. `refetch` is part of
  // the session atom's value — the same function `useSession().refetch` exposes.
  const sessionAtom = authClient.$store.atoms.session as { get: () => { refetch?: () => Promise<unknown> } } | undefined;
  const refetch = sessionAtom?.get().refetch;
  if (refetch) {
    await refetch();
    return;
  }
  // Fallback for a better-auth whose atom no longer carries `refetch`: the
  // documented signal still triggers a refetch, just without anything to await.
  authClient.$store.notify("$sessionSignal");
}

/**
 * Sign out and send the user to the marketing home page — always. Uses a hard
 * navigation (`window.location`) rather than the SPA router so all in-memory
 * session/query state is dropped and the app boots fresh as a signed-out
 * visitor. The redirect runs even if the sign-out request fails, so a stale
 * session can never strand the user on an authed screen.
 *
 * **The local copy is destroyed before the redirect, not after.** A hard reload
 * drops memory and nothing else: the query store in IndexedDB, the service
 * worker's recipe-image bucket and the localStorage snapshots (gate, session,
 * last partition) all survive it happily, and the session snapshot is what the
 * header reads — so the previous user's handle and avatar came back on the other
 * side of the sign-out, with their box, plan and list still on disk for the
 * snapshot's fourteen-day TTL. On a shared family iPad that is the §2.7 failure
 * exactly. Doing it here rather than leaving it to `useCachePartition` is
 * deliberate: this navigation may unmount the app before any effect observes the
 * session going away, so the one code path that *always* runs owns the wipe.
 * `wipeCachePartition` never rejects by contract, which is what allows it to be
 * awaited in a `finally` without the redirect below ever becoming unreachable.
 */
export async function signOutAndGoHome(): Promise<void> {
  // Clear the PostHog identity before the session goes away so the post-reload
  // anonymous visitor isn't linked to the signed-out user. A window event keeps
  // this module free of a PostHog dependency (listener lives in __root.tsx).
  window.dispatchEvent(new Event("posthog:reset"));
  try {
    await authClient.signOut();
  } finally {
    await wipeCachePartition("sign-out");
    window.location.href = "/";
  }
}
