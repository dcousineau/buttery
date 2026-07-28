import { redirect } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";

/**
 * Server-only session helpers shared by every household server function
 * (agents B and C import these). They wrap better-auth's `auth.api.getSession`
 * and centralize how the caller's validated DID is obtained.
 *
 * The DID returned here is the ONLY identity value that may be handed to
 * `assertMember` — it comes from the server-validated session, never from a
 * client argument.
 */

/** The better-auth session envelope: `{ session, user }`. */
export type ServerSession = typeof auth.$Infer.Session;

/**
 * Resolve request headers for `auth.api.getSession`. Inside a `createServerFn`
 * handler no `request` is passed — we read the ambient request via
 * `getRequest()`. Pass an explicit `request` from route/middleware contexts
 * that already have one.
 */
function resolveHeaders(request?: Request): Headers {
  return request?.headers ?? getRequest().headers;
}

/**
 * The current better-auth session (`{ session, user }`) or `null` when the
 * caller is unauthenticated. `session.active_household_id` (§3.4) rides along
 * on the returned `session`.
 */
export async function getServerSession(request?: Request): Promise<ServerSession | null> {
  return auth.api.getSession({ headers: resolveHeaders(request) });
}

/**
 * The validated caller DID, or a thrown redirect to `/login` when there is no
 * authenticated atproto session. Ergonomic first line for a `createServerFn`
 * handler:
 *
 * ```ts
 * const did = await requireSessionDid();
 * const membership = await assertMember(did, householdId, "owner");
 * ```
 */
export async function requireSessionDid(request?: Request): Promise<string> {
  const result = await getServerSession(request);
  const did = result?.user.did ?? null;
  if (!did) {
    throw redirect({ to: "/login" });
  }
  return did;
}
