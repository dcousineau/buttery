/**
 * Transport-level error classification for the port (offline plan §4.1, §4.3).
 *
 * M1 needs exactly two questions answered, both by the Query retry predicate:
 *
 * - **"Is retrying pointless?"** A 401/redirect-to-login is not a transient
 *   failure; retrying it three times just delays the sign-in prompt and burns a
 *   retry budget the offline path wants for real network flakiness.
 * - **"Is this the household saying no?"** A membership failure means the cached
 *   partition is no longer ours to hold, so it is wiped rather than retried
 *   (§2.7 — a shared family iPad must not keep one household's box after the
 *   member is removed from it).
 *
 * These are **predicates over thrown values, not new error classes.** Server
 * functions today throw `redirect()` objects and `NotAMemberError` instances,
 * and neither survives serialization as itself — a thrown class arrives at the
 * client as a plain object with a `message`. Sniffing the wire shape is the only
 * thing that actually works across the boundary, so that is what this does, and
 * it is why §6.1 replaces the whole arrangement with a discriminated
 * `MutationResult` union in M3 rather than with more classes.
 */

/** A thrown value, narrowed to something with a readable message. */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** The status code a server function's failure carried, when it carried one. */
function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return null;
}

/**
 * The session is gone (or was never there): the server threw `redirect({ to:
 * "/login" })` out of `activeContext()`, or the transport returned a 401.
 *
 * Never retried, and — importantly for M2 — never a reason to drop a queued
 * write: the queue outlives the cookie (§5.3).
 */
export function isSessionExpired(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 401) return true;
  // A thrown `redirect()` arrives as a plain object carrying its target.
  if (error && typeof error === "object") {
    const to = (error as { to?: unknown; options?: { to?: unknown } }).to ?? (error as { options?: { to?: unknown } }).options?.to;
    if (typeof to === "string" && to.startsWith("/login")) return true;
  }
  return /unauthenticated|not signed in/i.test(messageOf(error));
}

/**
 * The caller is not (or is no longer) a member of the household the request was
 * scoped to — `NotAMemberError`, or a 403.
 *
 * The cache partition is wiped on this, which is deliberately more aggressive
 * than the failure strictly requires: being removed from a household is rare,
 * and leaving its recipes readable on a shared device afterwards is the failure
 * mode §2.7 exists to prevent.
 */
export function isForbidden(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 403) return true;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "not_a_member" || code === "forbidden") return true;
  return /not a member/i.test(messageOf(error));
}

/**
 * The browser could not reach the server at all — as opposed to reaching it and
 * being told no. `TypeError: Failed to fetch` is what a dropped connection looks
 * like from `fetch`, in every engine, and it is the case the whole offline
 * design is built around.
 *
 * **Answers from the server are checked first, and they win.** The obvious
 * implementation — "offline if `navigator.onLine` is false" — is wrong in a way
 * that matters, because two callers act on this predicate:
 *
 * - `ensureActiveHousehold` falls back to a cached household when it is true,
 *   and its whole contract is that a thrown `redirect({ to: "/login" })` or a
 *   membership refusal still propagates. Short-circuiting on `onLine` swallowed
 *   both, keeping someone on a household they had been removed from.
 * - `OfflineRouteError` renders "not saved for offline yet" when it is true, and
 *   promises in its own comment to re-throw anything that is not a network
 *   failure. Short-circuiting made it a catch-all for *every* error that
 *   happened to occur while offline — which is how a real bug gets permanently
 *   disguised as a connectivity blip.
 *
 * A server that answered cannot also be unreachable, so those two cases return
 * false before `onLine` is consulted at all.
 */
export function isOffline(error: unknown): boolean {
  // The server reached us with a verdict; whatever the radio is doing, this is
  // not a connectivity failure.
  if (isSessionExpired(error) || isForbidden(error)) return false;
  if (error instanceof TypeError && /fetch|network|load failed/i.test(messageOf(error))) return true;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * The shared retry predicate. Reads as the rule it encodes: give up immediately
 * on anything the server decided, keep trying on anything the network did.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isSessionExpired(error) || isForbidden(error)) return false;
  return failureCount < 3;
}
