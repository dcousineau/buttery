import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB } from "#/db/types";
import type { McpConnection } from "#/lib/api/types";

/**
 * The AI apps a signed-in user has connected to Buttery through MCP OAuth, and
 * how they take that access back.
 *
 * better-auth's own `oauth2/delete-consent` only deletes the `oauth_consent`
 * row. It leaves the client's refresh tokens (which still mint new access
 * tokens) alive, and access tokens are stateless JWTs that the MCP endpoint
 * verifies by signature alone. "Disconnect" therefore does three things:
 *
 *   1. {@link revokeMcpConnection} deletes the consent AND every token row for
 *      that (user, client) in one transaction, so no refresh can succeed.
 *   2. {@link isMcpGrantActive}, called by the MCP endpoint on every request,
 *      rejects a JWT whose user no longer has a consent for the client, so
 *      already-issued access tokens die immediately instead of at expiry.
 *   3. The same check rejects a JWT issued BEFORE the current consent was
 *      granted, so reconnecting later does not resurrect an old token.
 *
 * Server fns resolve the user from the session; no user id is ever accepted
 * from the client.
 */

export type { McpConnection };

// --- pure helpers --------------------------------------------------------

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/** A readable name for a client: registered name, else its site's host, else its id's host, else the raw id. */
export function connectionName(client: { name: string | null; uri: string | null; clientId: string }): string {
  const name = client.name?.trim();
  if (name) return name;
  return hostOf(client.uri) ?? hostOf(client.clientId) ?? client.clientId;
}

/** Only https icons are shown: no `javascript:`/`data:` URLs, no mixed content, no plain http. */
export function safeIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type Row = { client_id: string; created_at: Date | null };

/** Newest `created_at` per client, as ms since epoch. */
function newestByClient(...sets: Row[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of sets.flat()) {
    if (!row.created_at) continue;
    const time = row.created_at.getTime();
    if (time > (out.get(row.client_id) ?? Number.NEGATIVE_INFINITY)) out.set(row.client_id, time);
  }
  return out;
}

/**
 * Whether a JWT access token is still backed by the user's consent.
 *
 * `consentGrantedAt` is the earliest live consent for (user, client), or null
 * when there is none. A token carries `iat` in whole seconds, so the consent
 * time is floored to seconds before comparing: a token can only be issued at or
 * after the consent that allowed it.
 */
export function isTokenBackedByConsent(consentGrantedAt: Date | null, tokenIssuedAtSeconds: number | undefined): boolean {
  if (!consentGrantedAt) return false;
  if (typeof tokenIssuedAtSeconds !== "number") return false;
  return tokenIssuedAtSeconds >= Math.floor(consentGrantedAt.getTime() / 1000);
}

// --- domain (takes the db so it is testable without a session) -----------

export async function listMcpConnections(db: Kysely<DB>, userId: string): Promise<McpConnection[]> {
  const consents = await db.selectFrom("oauth_consent").select(["client_id", "created_at"]).where("user_id", "=", userId).execute();
  if (consents.length === 0) return [];

  const clientIds = [...new Set(consents.map((consent) => consent.client_id))];
  const [clients, refresh, access] = await Promise.all([
    db.selectFrom("oauth_client").select(["client_id", "name", "uri", "icon"]).where("client_id", "in", clientIds).execute(),
    db
      .selectFrom("oauth_refresh_token")
      .select(["client_id", (eb) => eb.fn.max("created_at").as("created_at")])
      .where("user_id", "=", userId)
      .where("client_id", "in", clientIds)
      .groupBy("client_id")
      .execute(),
    db
      .selectFrom("oauth_access_token")
      .select(["client_id", (eb) => eb.fn.max("created_at").as("created_at")])
      .where("user_id", "=", userId)
      .where("client_id", "in", clientIds)
      .groupBy("client_id")
      .execute(),
  ]);

  // JWT access tokens are not stored, so the refresh-token rotation is the
  // real "the app came back" signal; stored access tokens count too.
  const lastActive = newestByClient(refresh, access);
  const byClient = new Map(clients.map((client) => [client.client_id, client]));
  const firstConsent = new Map<string, Date | null>();
  for (const consent of consents) {
    const known = firstConsent.get(consent.client_id);
    if (known === undefined || (consent.created_at && (!known || consent.created_at < known))) firstConsent.set(consent.client_id, consent.created_at);
  }

  return [...firstConsent.entries()]
    .map(([clientId, connectedAt]): McpConnection => {
      const client = byClient.get(clientId);
      const active = lastActive.get(clientId);
      return {
        clientId,
        name: connectionName({ name: client?.name ?? null, uri: client?.uri ?? null, clientId }),
        iconUrl: safeIconUrl(client?.icon),
        connectedAt: (connectedAt ?? new Date(0)).toISOString(),
        lastActiveAt: active === undefined ? null : new Date(active).toISOString(),
      };
    })
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

/**
 * Take back everything `clientId` was given: the consent and every access and
 * refresh token for this user, in one transaction. Tokens are deleted rather
 * than flagged revoked so a refresh-token replay window can never reissue them.
 * Scoped to `userId` throughout. Idempotent; returns whether a consent existed.
 */
export async function revokeMcpConnection(db: Kysely<DB>, userId: string, clientId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const consents = await trx.deleteFrom("oauth_consent").where("user_id", "=", userId).where("client_id", "=", clientId).executeTakeFirst();
    await trx.deleteFrom("oauth_access_token").where("user_id", "=", userId).where("client_id", "=", clientId).execute();
    await trx.deleteFrom("oauth_refresh_token").where("user_id", "=", userId).where("client_id", "=", clientId).execute();
    return consents.numDeletedRows > 0n;
  });
}

/** Earliest live consent for (user, client), or null. */
async function consentGrantedAt(db: Kysely<DB>, userId: string, clientId: string): Promise<Date | null> {
  const row = await db
    .selectFrom("oauth_consent")
    .select((eb) => eb.fn.min("created_at").as("created_at"))
    .where("user_id", "=", userId)
    .where("client_id", "=", clientId)
    .executeTakeFirst();
  return row?.created_at ?? null;
}

/**
 * The MCP endpoint's per-request check that a verified access token's grant has
 * not been withdrawn. `claims` are the signature-verified JWT payload.
 */
export async function isMcpGrantActive(db: Kysely<DB>, claims: { sub?: unknown; azp?: unknown; client_id?: unknown; iat?: unknown }): Promise<boolean> {
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null;
  if (!userId || !clientId) return false;
  const iat = typeof claims.iat === "number" ? claims.iat : undefined;
  return isTokenBackedByConsent(await consentGrantedAt(db, userId, clientId), iat);
}

// --- server functions ----------------------------------------------------

async function requireUserId(): Promise<string> {
  const { getServerSession } = await import("./household/session");
  const session = await getServerSession();
  if (!session) throw new Error("Sign in to manage your connected apps.");
  return session.user.id;
}

export const getMcpConnections = createServerFn({ method: "GET" }).handler(async (): Promise<McpConnection[]> => {
  const userId = await requireUserId();
  const { getDb } = await import("#/lib/db");
  return listMcpConnections(getDb(), userId);
});

export const disconnectMcpConnection = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ clientId: z.string().min(1).max(2048) }).parse(data))
  .handler(async ({ data }): Promise<{ disconnected: boolean }> => {
    const userId = await requireUserId();
    const { getDb } = await import("#/lib/db");
    return { disconnected: await revokeMcpConnection(getDb(), userId, data.clientId) };
  });
