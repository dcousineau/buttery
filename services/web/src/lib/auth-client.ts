import { createAuthClient } from "better-auth/react";
import { atprotoClient } from "./atproto/better-auth-client-plugin";

export const authClient = createAuthClient({
  plugins: [atprotoClient()],
});

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
