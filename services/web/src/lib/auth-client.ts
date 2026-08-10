import { createAuthClient } from "better-auth/react";
import { atprotoClient } from "./atproto/better-auth-client-plugin";
import { useHydrated } from "./hooks/use-hydrated";

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
 * Sign out and send the user to the marketing home page — always. Uses a hard
 * navigation (`window.location`) rather than the SPA router so all in-memory
 * session/query state is dropped and the app boots fresh as a signed-out
 * visitor. The redirect runs even if the sign-out request fails, so a stale
 * session can never strand the user on an authed screen.
 */
export async function signOutAndGoHome(): Promise<void> {
  // Clear the PostHog identity before the session goes away so the post-reload
  // anonymous visitor isn't linked to the signed-out user. A window event keeps
  // this module free of a PostHog dependency (listener lives in __root.tsx).
  window.dispatchEvent(new Event("posthog:reset"));
  try {
    await authClient.signOut();
  } finally {
    window.location.href = "/";
  }
}
