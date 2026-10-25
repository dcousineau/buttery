import { getDb } from "#/lib/db";
import type { ServerContext } from "@modelcontextprotocol/server";

export const text = (message: string, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: message }] });

/**
 * The caller's atproto DID. `server.ts` puts the verified token's user id on `authInfo`; the
 * DID is looked up from that, never taken from tool arguments, so an agent can only ever act
 * as the user who connected it.
 */
export async function callerDid(ctx: ServerContext): Promise<string | null> {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== "string") return null;
  const row = await getDb().selectFrom("user").select("did").where("id", "=", userId).executeTakeFirst();
  return row?.did ?? null;
}

export const NOT_SIGNED_IN = "Couldn't tell which Buttery account this connection belongs to. Disconnect and connect again.";
