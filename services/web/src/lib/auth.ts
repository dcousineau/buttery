import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { jwtSchema, oauthSchema } from "./auth-schema";
import { getDb } from "./db";
import { atprotoPlugin } from "./atproto/better-auth-plugin";
import { APP_URL, isLoopback } from "./atproto/oauth-node";

/** Canonical identifier of the MCP resource server; access tokens are audience-bound to it. */
export const MCP_RESOURCE = `${APP_URL}/mcp`;
/** Consent step for MCP OAuth clients — see routes/mcp/auth.tsx. */
export const MCP_CONSENT_PATH = "/mcp/auth";

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
  // membership on every request (see src/server/authz.ts). The physical
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
    // MCP: Buttery is its own OAuth 2.1 authorization server (users sign in via
    // atproto, MCP clients get a Buttery-issued token). `jwt()` is required by
    // `mcp()` for the signing key + `/jwks`; `cimd()` lets clients identify by
    // a metadata-document URL instead of dynamic registration. See
    // src/server/mcp/ for the resource server.
    jwt({ schema: jwtSchema }),
    mcp({
      schema: oauthSchema,
      loginPage: "/login",
      consentPage: MCP_CONSENT_PATH,
      resource: MCP_RESOURCE,
      // Local dev only: the MCP Inspector registers itself via RFC 7591 rather
      // than a client-metadata URL. Open registration stays off in production,
      // where clients identify through `cimd()` below.
      allowDynamicClientRegistration: isLoopback,
      allowUnauthenticatedClientRegistration: isLoopback,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    // Must stay last so cookies set by earlier plugins are handled.
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
