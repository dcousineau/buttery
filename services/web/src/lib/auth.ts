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
  plugins: [
    atprotoPlugin(),
    // Must stay last so cookies set by earlier plugins are handled.
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
