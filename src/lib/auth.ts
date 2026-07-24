import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getPool } from "./db";
import { atprotoPlugin } from "./atproto/better-auth-plugin";
import { APP_URL } from "./atproto/oauth-node";

// Server-only module. Sessions live in Postgres via the pg Pool (better-auth's
// built-in Kysely adapter); the only sign-in method is atproto OAuth.
export const auth = betterAuth({
  baseURL: APP_URL,
  database: getPool(),
  trustedOrigins: [APP_URL],
  plugins: [
    atprotoPlugin(),
    // Must stay last so cookies set by earlier plugins are handled.
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
