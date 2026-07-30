import { type Kysely } from "kysely";

/**
 * Adds `user.pds` — the atproto Personal Data Server host the account lives on
 * (e.g. `https://bsky.social`, a *.host.bsky.network shard, or a self-hosted /
 * Blacksky PDS). Resolved from the DID document at sign-in and refreshed on each
 * login by the atproto better-auth plugin, alongside the existing `image`
 * column (which the atproto flow now populates with the profile avatar URL).
 *
 * better-auth is told about this column via `schema.user.fields.pds` in
 * `src/lib/atproto/better-auth-plugin.ts` (`input: false` — server-set only, so
 * it surfaces on `session.user.pds` but can't be supplied by the client).
 *
 * `image` already exists (better-auth default column, created in
 * 1784997086507_create_initial_schema) — no schema change needed for it; it was
 * simply never written until now.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user").addColumn("pds", "text").execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("user").dropColumn("pds").execute();
}
