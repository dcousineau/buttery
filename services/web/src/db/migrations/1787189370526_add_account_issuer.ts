import { type Kysely } from "kysely";

/** Mirrors `ATPROTO_ACCOUNT_ISSUER` in `src/lib/atproto/better-auth-plugin.ts`. */
const ATPROTO_ISSUER = "local:atproto";

/**
 * better-auth 1.7 keys an external account by the pair (`issuer`, `accountId`)
 * instead of (`providerId`, `accountId`), and requires a new non-null
 * `account.issuer` column plus a unique compound index over the pair. See
 * https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-is-scoped-by-issuer.
 *
 * atproto is the app's only sign-in method, so every existing row backfills to
 * one value. The issuer is the synthetic `local:atproto` — `local:` (not
 * `local:oauth:`) because, like better-auth's own SIWE plugin, the atproto
 * plugin is not one of better-auth's OAuth providers; it hands better-auth an
 * already-resolved identity. A real atproto OAuth issuer would be the user's
 * entryway/PDS, which is per-account and changes when someone migrates hosts,
 * while `account.accountId` (the DID) is the identity that never moves. The
 * same constant lives in `src/lib/atproto/better-auth-plugin.ts` — change both
 * together or sign-in stops matching existing accounts.
 *
 * The upgrade guide's collision step is a no-op here: the DID is unique per
 * account and one issuer means (issuer, accountId) is as unique as `accountId`
 * already was. The column is added nullable, backfilled, then made NOT NULL, so
 * the migration runs on a populated table. Only `atproto` rows are backfilled:
 * a row from some other provider would leave `issuer` null and fail the NOT NULL
 * step loudly, which beats guessing an issuer for an account nobody expected.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("account").addColumn("issuer", "text").execute();
  await db.updateTable("account").set({ issuer: ATPROTO_ISSUER }).where("providerId", "=", "atproto").execute();
  await db.schema
    .alterTable("account")
    .alterColumn("issuer", (col) => col.setNotNull())
    .execute();
  await db.schema.createIndex("account_issuer_accountId_uidx").on("account").columns(["issuer", "accountId"]).unique().execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("account_issuer_accountId_uidx").execute();
  await db.schema.alterTable("account").dropColumn("issuer").execute();
}
