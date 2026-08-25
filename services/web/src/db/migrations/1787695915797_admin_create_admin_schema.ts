import { type Kysely, sql } from "kysely";

/**
 * The backoffice admin's own Postgres schema, and the better-auth tables that
 * live in it. See `services/admin/README.md`.
 *
 * **Why a schema and not a prefix.** The admin tool authenticates operators, not
 * cooks. It shares this database — that is the whole point, it reads the app's
 * real data — but it must never share an identity, a session or a cookie with
 * it. A separate `admin` schema is the hard line: an admin session row cannot
 * be mistaken for a `public.session` row by any query, and dropping the schema
 * removes every trace of the tool without touching the app.
 *
 * **Naming.** Tables are `admin_*` INSIDE the `admin` schema — redundant on
 * purpose. The admin service connects with `search_path = admin, public`, so an
 * unqualified `user` would silently resolve to `admin.user` and shadow the app's
 * table. Distinct names mean nothing shadows anything and every query reads
 * exactly as it resolves.
 *
 * **Column case.** camelCase (`emailVerified`, `createdAt`, …) matches
 * `1784997086507_create_initial_schema`: better-auth's Kysely adapter names its
 * columns and we do not get a vote. App-owned columns added here (`role`,
 * `disabled_at`) keep the repo's snake_case.
 *
 * Sign-in is email + password (`admin_account.password` holds the better-auth
 * hash under `providerId = 'credential'`). The Google/OIDC provider that
 * eventually replaces it lands in this same `admin_account` table with no schema
 * change — better-auth stores social accounts in the same shape.
 *
 * Migrations for the admin tool live here, in the web service, under the
 * `<timestamp>_admin_<description>` name so they are greppable as a group if
 * they ever move to a migration pathway of their own.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

// Column default: `CURRENT_TIMESTAMP` — the spelling the initial schema uses for
// the better-auth tables.
const now = sql`CURRENT_TIMESTAMP`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createSchema("admin").ifNotExists().execute();

  await db.schema
    .withSchema("admin")
    .createTable("admin_user")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("email", "text", (col) => col.notNull().unique())
    .addColumn("emailVerified", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("image", "text")
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    // App-owned. `viewer` reads, `admin` reads and (eventually) writes. Nothing
    // enforces a difference yet — every route requires a session and no more —
    // but the column exists so the first write surface has somewhere to look
    // instead of growing a second table.
    .addColumn("role", "text", (col) => col.notNull().defaultTo("admin"))
    // Soft lockout: set it and the operator can no longer sign in or use an
    // existing session, without losing the audit trail a hard delete would take
    // with it. Enforced in `services/admin/src/lib/auth.ts`.
    .addColumn("disabled_at", "timestamptz")
    .execute();

  await db.schema
    .withSchema("admin")
    .createTable("admin_session")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("expiresAt", "timestamptz", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("ipAddress", "text")
    .addColumn("userAgent", "text")
    .addColumn("userId", "text", (col) => col.notNull().references("admin.admin_user.id").onDelete("cascade"))
    .execute();

  await db.schema
    .withSchema("admin")
    .createTable("admin_account")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("accountId", "text", (col) => col.notNull())
    .addColumn("providerId", "text", (col) => col.notNull())
    // better-auth 1.7 keys an external account by (`issuer`, `accountId`) rather
    // than (`providerId`, `accountId`) and requires this column plus the unique
    // index below — see `1787189370526_add_account_issuer`, which retrofitted
    // the same pair onto the app's `public.account`. A credential (email +
    // password) account gets `issuer = 'credential'`; the Google provider that
    // eventually lands here gets its OIDC issuer, and the pair keeps two
    // providers that happen to agree on an account id apart.
    .addColumn("issuer", "text", (col) => col.notNull())
    .addColumn("userId", "text", (col) => col.notNull().references("admin.admin_user.id").onDelete("cascade"))
    .addColumn("accessToken", "text")
    .addColumn("refreshToken", "text")
    .addColumn("idToken", "text")
    .addColumn("accessTokenExpiresAt", "timestamptz")
    .addColumn("refreshTokenExpiresAt", "timestamptz")
    .addColumn("scope", "text")
    // The bcrypt-ish hash better-auth writes for email+password sign-in. Null
    // for a social account.
    .addColumn("password", "text")
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  await db.schema
    .withSchema("admin")
    .createTable("admin_verification")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identifier", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("expiresAt", "timestamptz", (col) => col.notNull())
    .addColumn("createdAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updatedAt", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  await db.schema.withSchema("admin").createIndex("admin_account_issuer_accountId_uidx").on("admin_account").columns(["issuer", "accountId"]).unique().execute();

  await db.schema.withSchema("admin").createIndex("admin_session_userId_idx").on("admin_session").column("userId").execute();
  await db.schema.withSchema("admin").createIndex("admin_account_userId_idx").on("admin_account").column("userId").execute();
  await db.schema.withSchema("admin").createIndex("admin_verification_identifier_idx").on("admin_verification").column("identifier").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Drop the tables rather than the schema: a later admin migration may have
  // added its own objects to `admin`, and `dropSchema` would take them with it.
  // Indexes drop implicitly with their tables.
  await db.schema.withSchema("admin").dropTable("admin_verification").ifExists().execute();
  await db.schema.withSchema("admin").dropTable("admin_account").ifExists().execute();
  await db.schema.withSchema("admin").dropTable("admin_session").ifExists().execute();
  await db.schema.withSchema("admin").dropTable("admin_user").ifExists().execute();
}
