import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
// Explicit `.ts` extension: `scripts/create-admin.ts` imports this module under
// plain `node` (which strips types but does not guess extensions), and an
// extensionless specifier here is what breaks that chain. Vite resolves it
// either way. Same reason `services/web/scripts/reset-user-data.ts` reaches for
// `../src/lib/db.ts`.
import { getDb } from "./db.ts";

/**
 * Server-only module. The admin's better-auth instance — a **completely
 * separate** authentication scheme from the app's.
 *
 * Three things make it separate, and all three are load-bearing:
 *
 * 1. **Different tables.** `admin_user` / `admin_session` / `admin_account` /
 *    `admin_verification`, all in the `admin` Postgres schema, reached through
 *    the `search_path = admin, public` pool in `db.ts`. No row here can be
 *    confused with a `public.session` row, and an app sign-in writes nothing
 *    the admin reads.
 *
 * 2. **A different secret.** `ADMIN_BETTER_AUTH_SECRET`, not the app's
 *    `BETTER_AUTH_SECRET`. If the two shared a secret, a session token minted
 *    by one would verify against the other and the table split would be
 *    decoration.
 *
 * 3. **A different cookie prefix.** This is the subtle one: **cookies ignore
 *    ports**. `127.0.0.1:3000` and `127.0.0.1:3100` are one origin as far as
 *    the cookie jar is concerned, so under the default `better-auth.*` prefix
 *    the admin and the app would overwrite each other's session cookie in local
 *    dev — signing in here would sign you out there, and vice versa.
 *    `buttery-admin.*` keeps the two jars disjoint.
 *
 * **Sign-in is email + password, and sign-*up* is closed.** `disableSignUp`
 * turns off registration everywhere, the server-side `auth.api.signUpEmail`
 * included — so minting an operator needs a second instance built with it off,
 * which is what `createAdminAuth` is for and why `scripts/create-admin.ts` is
 * the only caller that passes `allowSignUp: true`. That script runs from a
 * shell, so an account requires access to the machine and the database, and it
 * goes through better-auth rather than writing rows itself: a hand-rolled
 * INSERT is how you get an account that exists and can never sign in.
 *
 * Google/OIDC is the eventual replacement for the password and drops into the
 * `socialProviders` option with no schema change — better-auth stores a social
 * login in the same `admin_account` table this already uses.
 */
const ADMIN_APP_URL = process.env.ADMIN_APP_URL ?? "http://127.0.0.1:3100";

/**
 * The instance the app runs on has `allowSignUp: false`; the account-minting
 * script builds a second one with it true. Everything else — tables, secret,
 * cookie prefix, password hashing — is identical between them by construction,
 * which is the point of a factory rather than two configs.
 */
export function createAdminAuth({ allowSignUp = false }: { allowSignUp?: boolean } = {}) {
  return betterAuth({
    baseURL: ADMIN_APP_URL,
    secret: process.env.ADMIN_BETTER_AUTH_SECRET,
    database: { db: getDb(), type: "postgres" },
    trustedOrigins: [ADMIN_APP_URL],
    emailAndPassword: {
      enabled: true,
      // See the module comment: accounts come from the CLI, never from the web.
      disableSignUp: !allowSignUp,
      // No mail transport is wired into this service and none is wanted — an
      // internal tool with a handful of hand-minted accounts has nothing to
      // verify. `admin_user.emailVerified` defaults to false and stays there.
      requireEmailVerification: false,
    },
    user: {
      modelName: "admin_user",
      additionalFields: {
        // Read by `requireAdmin()`. Nothing branches on it yet — every route
        // needs a session and no more — but the first write surface has somewhere
        // to look instead of growing a second table.
        role: { type: "string", required: false, input: false },
        // Soft lockout. `requireAdmin()` rejects a session whose operator has
        // this set, so revoking access is one UPDATE and keeps the audit trail a
        // hard delete would take with it.
        disabled_at: { type: "date", required: false, input: false },
      },
    },
    session: { modelName: "admin_session" },
    account: { modelName: "admin_account" },
    verification: { modelName: "admin_verification" },
    advanced: { cookiePrefix: "buttery-admin" },
    plugins: [
      // Must stay last so cookies set by earlier plugins are handled.
      tanstackStartCookies(),
    ],
  });
}

export const auth = createAdminAuth();

export type AdminSession = typeof auth.$Infer.Session;
