import { NodeOAuthClient, type NodeSavedSession, type NodeSavedSessionStore, type NodeSavedState, type NodeSavedStateStore } from "@atproto/oauth-client-node";
import { requestLocalLock } from "@atproto/oauth-client";
import { atprotoLoopbackClientMetadata } from "@atproto/oauth-types";
import { sql } from "kysely";
import { getDb } from "../db";
import type { OAuthClientMetadataInput } from "@atproto/oauth-client";

// Prod resolves handles via bsky.social. In local dev, point this (and
// ATPROTO_PLC_URL below) at a local @atproto/dev-env network so the whole
// login → DID resolve → PDS write chain stays off the real atmosphere. See
// services/atproto-dev-env. Unset → prod behavior, unchanged.
const HANDLE_RESOLVER = process.env.ATPROTO_HANDLE_RESOLVER ?? "https://bsky.social";

// Server-only module: the OAuth dance (PAR, DPoP, token exchange) runs here;
// the browser only ever sees the better-auth session cookie.
const RAW_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";

const rawHostname = new URL(RAW_URL).hostname;
const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(rawHostname) || rawHostname.endsWith(".localhost");

// atproto forbids local hostnames in web client_ids (`.localhost` TLDs
// included — e.g. the https://*.railway.localhost URL `railway dev` injects);
// the only local option is the `http://localhost` loopback client, whose
// redirect must target 127.0.0.1. So any local hostname collapses to the
// vite dev origin — browse the app there.
export const APP_URL = isLoopback ? `http://127.0.0.1:${process.env.PORT ?? "3000"}` : RAW_URL;

const REDIRECT_URI = `${APP_URL}/api/auth/atproto/callback`;

/**
 * In dev the atproto loopback client is used (`http://localhost` client_id
 * with metadata derived from its query string; redirect must target
 * 127.0.0.1, so browse the dev server at http://127.0.0.1:3000). In
 * production the app serves this metadata at /oauth-client-metadata.json and
 * that URL is the client_id.
 */
export const clientMetadata: OAuthClientMetadataInput = isLoopback
  ? atprotoLoopbackClientMetadata(`http://localhost?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent("atproto")}`)
  : {
      client_id: `${APP_URL}/oauth-client-metadata.json`,
      client_name: "Buttery",
      client_uri: APP_URL,
      redirect_uris: [REDIRECT_URI],
      scope: "atproto",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    };

// Tables are created by `npx @better-auth/cli migrate` from the atproto
// better-auth plugin's schema (see better-auth-plugin.ts).
function createStateStore(): NodeSavedStateStore {
  const db = getDb();
  return {
    async set(key, state) {
      await db
        .insertInto("atproto_oauth_state")
        .values({ id: crypto.randomUUID(), key, value: JSON.stringify(state), createdAt: sql`now()` })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: (eb) => eb.ref("excluded.value"), createdAt: sql`now()` }))
        .execute();
      // Abandoned sign-in attempts are worthless after the authorize redirect
      // expires; sweep them opportunistically instead of running a job.
      await db
        .deleteFrom("atproto_oauth_state")
        .where("createdAt", "<", sql<Date>`now() - interval '1 hour'`)
        .execute();
    },
    async get(key) {
      const row = await db.selectFrom("atproto_oauth_state").select("value").where("key", "=", key).executeTakeFirst();
      return row ? (JSON.parse(row.value) as NodeSavedState) : undefined;
    },
    async del(key) {
      await db.deleteFrom("atproto_oauth_state").where("key", "=", key).execute();
    },
  };
}

function createSessionStore(): NodeSavedSessionStore {
  const db = getDb();
  return {
    async set(did, session) {
      await db
        .insertInto("atproto_oauth_session")
        .values({ id: crypto.randomUUID(), key: did, value: JSON.stringify(session), createdAt: sql`now()`, updatedAt: sql`now()` })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: (eb) => eb.ref("excluded.value"), updatedAt: sql`now()` }))
        .execute();
    },
    async get(did) {
      const row = await db.selectFrom("atproto_oauth_session").select("value").where("key", "=", did).executeTakeFirst();
      return row ? (JSON.parse(row.value) as NodeSavedSession) : undefined;
    },
    async del(did) {
      await db.deleteFrom("atproto_oauth_session").where("key", "=", did).execute();
    },
  };
}

let client: NodeOAuthClient | undefined;

export function getAtprotoOAuthClient(): NodeOAuthClient {
  if (!client) {
    client = new NodeOAuthClient({
      clientMetadata,
      handleResolver: HANDLE_RESOLVER,
      // Local dev: resolve did:plc via a local PLC (services/atproto-dev-env) so
      // DID resolution never hits plc.directory. Unset → the default
      // https://plc.directory (prod, unchanged).
      ...(process.env.ATPROTO_PLC_URL ? { plcDirectoryUrl: process.env.ATPROTO_PLC_URL } : {}),
      allowHttp: isLoopback,
      requestLock: requestLocalLock,
      stateStore: createStateStore(),
      sessionStore: createSessionStore(),
    });
  }
  return client;
}
