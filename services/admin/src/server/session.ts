import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

/**
 * Server-only session helpers. Every admin server function starts with
 * `requireAdmin()` — there is no such thing as an unauthenticated read in this
 * tool, because there is no public surface in it.
 *
 * `auth` and `getDb` are pulled in with a dynamic `import()` inside each handler
 * so `better-auth` and `pg` stay out of the client bundle (the same rule the app
 * follows in `services/web/src/server/**`, and belt-and-braces with the
 * `importProtection` list in vite.config.ts).
 */

/** What a route needs to know about the signed-in operator. */
export interface AdminIdentity {
  id: string;
  name: string;
  email: string;
  role: string;
}

async function resolveSession(): Promise<AdminIdentity | null> {
  const { auth } = await import("#/lib/auth");
  const result = await auth.api.getSession({ headers: getRequest().headers });
  const user = result?.user;
  if (!user) return null;

  // The soft lockout from `admin.admin_user.disabled_at` is enforced HERE and
  // not at sign-in, deliberately: this is the check every request already runs,
  // so revoking an operator takes effect on their next click rather than
  // whenever their current session happens to expire. Read live from the row
  // rather than trusting the session payload, which was minted before the
  // revocation.
  const { getDb } = await import("#/lib/db");
  const row = await getDb().selectFrom("admin.admin_user").where("id", "=", user.id).select(["id", "name", "email", "role", "disabled_at"]).executeTakeFirst();

  if (!row || row.disabled_at !== null) return null;

  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

/**
 * The signed-in operator, or a thrown redirect to `/login`. Ergonomic first
 * line for any admin handler:
 *
 * ```ts
 * await requireAdmin();
 * ```
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = await resolveSession();
  if (!identity) {
    throw redirect({ to: "/login" });
  }
  return identity;
}

/**
 * The signed-in operator or `null`, without redirecting. Used by the `_authed`
 * layout's `beforeLoad` (which wants to redirect itself, carrying the attempted
 * URL) and by `/login` (which bounces an already-signed-in operator home).
 */
export const fetchAdminIdentity = createServerFn({ method: "GET" }).handler(async (): Promise<AdminIdentity | null> => resolveSession());
