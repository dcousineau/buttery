import { type Kysely, sql } from "kysely";

/**
 * The household spine — the multi-tenant boundary every piece of PRIVATE
 * Buttery data descends from. See `docs/plans/02-households-and-private-foundation.md`.
 *
 * Tables (3):
 *   - `household`         — the tenant; soft-deletable; always has ≥1 live owner
 *   - `household_member`  — DID ↔ household membership + role (owner|member)
 *   - `household_invite`  — bound (DID-locked) or open (token-link) invites
 *
 * Also extends the better-auth `session` table with `active_household_id`
 * (§3.4). The column is declared here so it physically exists; better-auth is
 * told about it via `session.additionalFields` in `src/lib/auth.ts` so it will
 * persist/read the value. Nullable, no default — a session starts with no
 * active household until join/create/switch sets one.
 *
 * PRIVACY / IDENTITY (§13): these tables are Buttery-PRIVATE. They are NEVER
 * written to a PDS or any atproto repo — unlike `atproto_*` and `recipe`, which
 * mirror/project network records. The DID is the durable identity key for all
 * authorization; `handle` is only ever a denormalized cache elsewhere and is
 * deliberately absent here. No FK ties a DID to a `user` row: a DID can be
 * named by a bound invite (or retained as a tombstone) before — or after — any
 * Buttery `user` exists. IDs are app-minted ULIDs stored as `text`; the ULID is
 * the one shape kept for a possible future atproto "spaces" migration.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

// Column default: `now()`.
const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- household --------------------------------------------------------
  await db.schema
    .createTable("household")
    .addColumn("id", "text", (col) => col.primaryKey()) // app-minted ULID
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_by_did", "text", (col) => col.notNull()) // founding owner's DID
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("deleted_at", "timestamptz") // soft-delete; NULL = live
    .execute();

  // Live-household lookups (the common case) skip tombstoned rows.
  await sql`
    create index household_live_idx
      on household (id)
      where deleted_at is null
  `.execute(db);

  // --- household_member -------------------------------------------------
  await db.schema
    .createTable("household_member")
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("did", "text", (col) => col.notNull()) // member's atproto DID
    .addColumn("role", "text", (col) => col.notNull()) // 'owner' | 'member' (free text, extensible)
    .addColumn("joined_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("invited_by_did", "text") // NULL for the founder
    .addColumn("deleted_at", "timestamptz") // soft-delete (removed / left / account-deleted)
    .addColumn("tombstoned", "boolean", (col) => col.notNull().defaultTo(false)) // retained for a deleted atproto account
    // A DID appears at most once per household.
    .addPrimaryKeyConstraint("household_member_pkey", ["household_id", "did"])
    .execute();

  // "Which households am I in" lookups.
  await db.schema.createIndex("household_member_did_idx").on("household_member").column("did").execute();

  // Makes the ≥1-owner invariant check cheap (§7.1).
  await sql`
    create index household_member_live_owner_idx
      on household_member (household_id)
      where deleted_at is null and role = 'owner'
  `.execute(db);

  // --- household_invite -------------------------------------------------
  await db.schema
    .createTable("household_invite")
    .addColumn("id", "text", (col) => col.primaryKey()) // ULID
    .addColumn("token_hash", "text", (col) => col.notNull().unique()) // hash(token); raw token never stored
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    .addColumn("role", "text", (col) => col.notNull().defaultTo("member")) // role granted on acceptance
    .addColumn("created_by_did", "text", (col) => col.notNull()) // must be an owner at creation time
    .addColumn("bound_to_did", "text") // set = only this DID may accept; NULL = open link
    .addColumn("max_uses", "integer", (col) => col.notNull().defaultTo(1)) // open links may raise; bound = 1
    .addColumn("uses", "integer", (col) => col.notNull().defaultTo(0)) // incremented on each acceptance
    .addColumn("expires_at", "timestamptz") // NULL = no expiry (UI sets one)
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("revoked_at", "timestamptz") // owner revoked the invite
    // pending | accepted | declined | revoked | expired (materialized convenience;
    // `expires_at < now()` is authoritative for gating regardless of this value).
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .execute();

  // Auto-surfaces a caller's pending bound invites on login (§5).
  await sql`
    create index household_invite_pending_bound_idx
      on household_invite (bound_to_did)
      where status = 'pending' and bound_to_did is not null
  `.execute(db);

  // --- session.active_household_id (§3.4) --------------------------------
  // The household the UI is currently scoped to. Declared to better-auth via
  // `session.additionalFields` in src/lib/auth.ts; validated every request.
  await db.schema.alterTable("session").addColumn("active_household_id", "text").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order. Indexes drop implicitly with their tables.
  await db.schema.alterTable("session").dropColumn("active_household_id").execute();
  await db.schema.dropTable("household_invite").ifExists().execute();
  await db.schema.dropTable("household_member").ifExists().execute();
  await db.schema.dropTable("household").ifExists().execute();
}
