import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getDb } from "./db";
import { atprotoPlugin } from "./atproto/better-auth-plugin";
import { APP_URL } from "./atproto/oauth-node";

// Server-only module. Sessions live in Postgres, queried through the shared
// Kysely instance from `getDb()` — better-auth uses Kysely internally, so
// handing it our instance keeps auth and app queries on one connection pool.
// The only sign-in method is atproto OAuth.
export const auth = betterAuth({
  baseURL: APP_URL,
  database: { db: getDb(), type: "postgres" },
  trustedOrigins: [APP_URL],
  // The household the UI is currently scoped to (§3.4 of the households plan).
  // Persisted on the better-auth `session` row and re-validated against a live
  // membership on every request (see src/lib/household/authz.ts). The physical
  // `session.active_household_id` column is added by migration
  // 1785400000000_create_household_tables. Declaring it here is what makes
  // better-auth read/write the value; `input: false` keeps it server-set only
  // (never accepted from client-supplied session input).
  session: {
    additionalFields: {
      active_household_id: { type: "string", required: false, input: false },
    },
  },
  plugins: [
    atprotoPlugin(),
    // Must stay last so cookies set by earlier plugins are handled.
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
