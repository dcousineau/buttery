import { type Kysely } from "kysely";

/** The value 1787189370526_add_account_issuer backfilled, restored by `down`. */
const ATPROTO_ISSUER = "local:atproto";

/**
 * better-auth 1.7.3 reverted the issuer-scoped account key that 1.7.0–1.7.2
 * introduced: an account is recognized by (`providerId`, `accountId`) again and
 * nothing writes `account.issuer` anymore. See
 * https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key.
 *
 * Leaving the NOT NULL column in place breaks every account insert — better-auth
 * drops the unknown field and Postgres rejects the row — so this undoes
 * 1787189370526_add_account_issuer. The index goes before the column: the guide
 * warns that dropping the column first leaves engines rebuilding the compound
 * unique index as a unique constraint on `accountId` alone.
 *
 * Nothing is lost. `issuer` held one synthetic constant for every atproto row,
 * and the identity that matters — the DID in `accountId` — is untouched, so
 * `down` recreates the column by backfilling that same constant.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("account_issuer_accountId_uidx").execute();
  await db.schema.alterTable("account").dropColumn("issuer").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("account").addColumn("issuer", "text").execute();
  await db.updateTable("account").set({ issuer: ATPROTO_ISSUER }).where("providerId", "=", "atproto").execute();
  await db.schema
    .alterTable("account")
    .alterColumn("issuer", (col) => col.setNotNull())
    .execute();
  await db.schema.createIndex("account_issuer_accountId_uidx").on("account").columns(["issuer", "accountId"]).unique().execute();
}
