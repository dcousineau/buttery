import { type Kysely, sql } from "kysely";

/**
 * Initial schema. Ports `scripts/better-auth.sql` — the better-auth core tables
 * (user / session / account / verification) plus the atproto OAuth plugin's
 * state/session tables — to a Kysely migration.
 *
 * Built with the schema query builder; raw `sql` is used only for the
 * `CURRENT_TIMESTAMP` column defaults, which have no builder primitive.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface.
 */

// Column default: `CURRENT_TIMESTAMP`.
const now = sql`CURRENT_TIMESTAMP`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("user")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("emailVerified", "boolean", (col) => col.notNull())
    .addColumn("image", "text")
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("did", "text", (col) => col.unique())
    .addColumn("handle", "text")
    .execute();

  await db.schema
    .createTable("session")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("expiresAt", "timestamptz", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull())
    .addColumn("ipAddress", "text")
    .addColumn("userAgent", "text")
    .addColumn("userId", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .execute();

  await db.schema
    .createTable("account")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("accountId", "text", (col) => col.notNull())
    .addColumn("providerId", "text", (col) => col.notNull())
    .addColumn("userId", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("accessToken", "text")
    .addColumn("refreshToken", "text")
    .addColumn("idToken", "text")
    .addColumn("accessTokenExpiresAt", "timestamptz")
    .addColumn("refreshTokenExpiresAt", "timestamptz")
    .addColumn("scope", "text")
    .addColumn("password", "text")
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("verification")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identifier", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("expiresAt", "timestamptz", (col) => col.notNull())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  await db.schema
    .createTable("atproto_oauth_state")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("key", "text", (col) => col.notNull().unique())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("atproto_oauth_session")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("key", "text", (col) => col.notNull().unique())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull())
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("session_userId_idx").on("session").column("userId").execute();
  await db.schema.createIndex("account_userId_idx").on("account").column("userId").execute();
  await db.schema.createIndex("verification_identifier_idx").on("verification").column("identifier").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Drop in reverse dependency order. Tables with FKs to "user" go first;
  // indexes drop implicitly with their tables.
  await db.schema.dropTable("atproto_oauth_session").ifExists().execute();
  await db.schema.dropTable("atproto_oauth_state").ifExists().execute();
  await db.schema.dropTable("verification").ifExists().execute();
  await db.schema.dropTable("account").ifExists().execute();
  await db.schema.dropTable("session").ifExists().execute();
  await db.schema.dropTable("user").ifExists().execute();
}
