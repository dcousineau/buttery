/**
 * Client-side "pending invite" hand-off for the LOGGED-OUT invite → OAuth
 * round-trip (§15). No server deps — safe in the client bundle.
 *
 * WHY A COOKIE (mechanism, and the empirical caveat):
 * The atproto OAuth callback (`src/lib/atproto/better-auth-plugin.ts`, owned by
 * Agent A) ALWAYS finishes with `redirect("/")` — it has no `returnTo`/`next`
 * parameter and we must not modify it. So a logged-out visitor on
 * `/invite/<token>` can't be returned straight to that route after auth.
 *
 * Instead, before sending them to `/login`, we stash the raw token in a
 * short-lived FIRST-PARTY cookie. After sign-in the browser lands on `/`, where
 * a small resume effect (see `routes/index.tsx`) reads the cookie and forwards
 * to `/invite/<token>`. A first-party cookie on our own origin survives the
 * round-trip because the OAuth hop leaves and returns to the SAME origin, and
 * cookies are origin-scoped (not cleared by a cross-origin navigation). We read
 * it via `document.cookie` on return, so `SameSite=Lax` is sufficient — the
 * value is never needed cross-site, only re-read locally. `SameSite=Lax` also
 * lets it ride the top-level GET redirect back from the authorization server.
 *
 * NOTE (unverifiable in the sandbox): the app can't be run here (no DB, no
 * `pnpm dev`), so this survival was reasoned about, not observed end-to-end. A
 * human must confirm the round-trip once the dev DB is reachable.
 */

/** The first-party cookie carrying a raw invite token across the OAuth hop.
 * Exported so the server-side home gate (`resolveHomeRedirect`) can read it from
 * the request headers and resume the invite — the same value written here. */
export const PENDING_INVITE_COOKIE = "buttery_pending_invite";
const COOKIE = PENDING_INVITE_COOKIE;
const MAX_AGE_SECONDS = 10 * 60; // 10 minutes — just long enough to sign in.

/** Stash the raw invite token before redirecting a logged-out visitor to /login. */
export function stashPendingInvite(token: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
}

/** Read the stashed token (or null). Does not clear it. */
export function readPendingInvite(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(COOKIE.length + 1);
  return raw ? decodeURIComponent(raw) : null;
}

/** Clear the stashed token once it's been consumed (or is no longer wanted). */
export function clearPendingInvite(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

/** Extract a user-facing message from an unknown thrown value. The household
 * typed errors (Agent A) carry friendly `.message` text (e.g. LastOwnerError →
 * "Promote another owner or delete the household first."), and TanStack Start
 * preserves `.message` across the server-fn boundary even though `instanceof`
 * does not survive serialization — so displaying the message is the reliable,
 * typed-meaning-preserving branch. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    const msg = (err as { message: string }).message;
    return msg.length > 0 ? msg : fallback;
  }
  return fallback;
}
