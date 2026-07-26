import { NodeOAuthClient, type NodeSavedSession, type NodeSavedSessionStore, type NodeSavedState, type NodeSavedStateStore } from "@atproto/oauth-client-node";
import { requestLocalLock } from "@atproto/oauth-client";
import { atprotoLoopbackClientMetadata } from "@atproto/oauth-types";
import { getPool } from "../db";
import type { OAuthClientMetadataInput } from "@atproto/oauth-client";

const HANDLE_RESOLVER = "https://bsky.social";

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
  const pool = getPool();
  return {
    async set(key, state) {
      await pool.query(
        `insert into "atproto_oauth_state" ("id", "key", "value", "createdAt")
         values ($1, $2, $3, now())
         on conflict ("key") do update
           set "value" = excluded."value", "createdAt" = now()`,
        [crypto.randomUUID(), key, JSON.stringify(state)],
      );
      // Abandoned sign-in attempts are worthless after the authorize redirect
      // expires; sweep them opportunistically instead of running a job.
      await pool.query(`delete from "atproto_oauth_state" where "createdAt" < now() - interval '1 hour'`);
    },
    async get(key) {
      const res = await pool.query<{ value: string }>(`select "value" from "atproto_oauth_state" where "key" = $1`, [key]);
      const row = res.rows[0];
      return row ? (JSON.parse(row.value) as NodeSavedState) : undefined;
    },
    async del(key) {
      await pool.query(`delete from "atproto_oauth_state" where "key" = $1`, [key]);
    },
  };
}

function createSessionStore(): NodeSavedSessionStore {
  const pool = getPool();
  return {
    async set(did, session) {
      await pool.query(
        `insert into "atproto_oauth_session" ("id", "key", "value", "createdAt", "updatedAt")
         values ($1, $2, $3, now(), now())
         on conflict ("key") do update
           set "value" = excluded."value", "updatedAt" = now()`,
        [crypto.randomUUID(), did, JSON.stringify(session)],
      );
    },
    async get(did) {
      const res = await pool.query<{ value: string }>(`select "value" from "atproto_oauth_session" where "key" = $1`, [did]);
      const row = res.rows[0];
      return row ? (JSON.parse(row.value) as NodeSavedSession) : undefined;
    },
    async del(did) {
      await pool.query(`delete from "atproto_oauth_session" where "key" = $1`, [did]);
    },
  };
}

let client: NodeOAuthClient | undefined;

export function getAtprotoOAuthClient(): NodeOAuthClient {
  if (!client) {
    client = new NodeOAuthClient({
      clientMetadata,
      handleResolver: HANDLE_RESOLVER,
      allowHttp: isLoopback,
      requestLock: requestLocalLock,
      stateStore: createStateStore(),
      sessionStore: createSessionStore(),
    });
  }
  return client;
}
