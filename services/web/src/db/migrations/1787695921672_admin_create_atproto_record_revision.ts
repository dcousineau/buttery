import { type Kysely, sql } from "kysely";

/**
 * Revision history for atproto records, for the backoffice admin's record
 * detail view.
 *
 * **The problem.** `public.atproto_collection_recipe` is a *current-state*
 * index: the cron sweep upserts the latest version of each record and the
 * previous `cid`/`rev`/`record` is overwritten. atproto itself offers no
 * "list the revisions of this record" endpoint either — a repo's history lives
 * in its commit log (`com.atproto.sync.getRepo`, or the firehose), which the
 * sweep does not read. So "what did this record look like last week" is a
 * question nothing in the system could answer.
 *
 * **The fix.** Capture a row every time the index observes a record change.
 * That is deliberately *observed* history, not repo history: it starts the day
 * this migration runs, and it has one entry per sweep that saw something
 * different, not one per repo commit. It is the honest thing the data supports,
 * and it is what an operator actually wants — "when did we see this change, and
 * what changed".
 *
 * **Why a trigger.** The alternative is teaching `services/atproto-cron-sync` to
 * write a second table, which puts a second writer (and a second place to
 * forget) on the sweep's hot path. A trigger captures every writer for free —
 * the sweep today, a backfill script, a hand-run `UPDATE` during an incident —
 * and drops cleanly with `down()`. The cost is one INSERT per *changed* record
 * per sweep; unchanged rows re-upserted with the same `cid` and `rev` write
 * nothing, which is the overwhelming majority of a sweep.
 *
 * The trigger lives on a `public` table but writes only into `admin`, and both
 * it and its function go away with `down()` — the app's write path is left
 * exactly as it was.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

// Column default: `now()` — the spelling the `atproto_*` tables use.
const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createSchema("admin").ifNotExists().execute();

  await db.schema
    .withSchema("admin")
    .createTable("atproto_record_revision")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    // Deliberately NOT a foreign key to `atproto_collection_recipe`: history has
    // to outlive the row it describes. The sweep hard-deletes nothing today
    // (it sets `deleted_at`), but a future prune must not silently take the
    // audit trail with it.
    .addColumn("did", "text", (col) => col.notNull())
    .addColumn("rkey", "text", (col) => col.notNull())
    .addColumn("collection", "text", (col) => col.notNull())
    .addColumn("uri", "text", (col) => col.notNull())
    .addColumn("cid", "text", (col) => col.notNull())
    .addColumn("rev", "text", (col) => col.notNull())
    // The full record as observed. Null only for a `deleted` revision, where
    // the sweep has nothing left to store.
    .addColumn("record", "jsonb")
    .addColumn("name", "text")
    .addColumn("record_created_at", "timestamptz")
    .addColumn("record_updated_at", "timestamptz")
    .addColumn("validation_status", "text")
    // 'backfill' | 'created' | 'updated' | 'deleted' | 'restored'.
    //   backfill — the state at the moment this migration ran; there is exactly
    //              one per record that already existed, and it is not evidence
    //              the record was created then.
    //   created  — first time the index saw this (did, rkey).
    //   updated  — cid or rev moved.
    //   deleted  — `deleted_at` went from null to set (a tombstone on the PDS).
    //   restored — `deleted_at` went from set back to null.
    .addColumn("action", "text", (col) => col.notNull())
    // When *we* saw it, which is the only timestamp this table can honestly
    // claim. The record's own `record_updated_at` is beside it, unmodified.
    .addColumn("observed_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addCheckConstraint("atproto_record_revision_action_check", sql`action in ('backfill', 'created', 'updated', 'deleted', 'restored')`)
    .execute();

  // The one query the detail view runs: this record's revisions, newest first.
  await db.schema.withSchema("admin").createIndex("atproto_record_revision_record_idx").on("atproto_record_revision").columns(["did", "rkey", "observed_at desc"]).execute();
  // The one query the list view runs: what changed across the network lately.
  await db.schema
    .withSchema("admin")
    .createIndex("atproto_record_revision_observed_at_idx")
    .on("atproto_record_revision")
    .expression(sql`observed_at desc`)
    .execute();

  // `search_path` is pinned so the function resolves the same way no matter
  // which connection fires it (the cron sweep's raw `pg` client, the web app's
  // pool, or psql). `SECURITY INVOKER` is the default and the right one: the
  // writer needs INSERT on the history table, which is exactly the access the
  // sweep already has to the database.
  await sql`
    create or replace function admin.capture_atproto_record_revision()
    returns trigger
    language plpgsql
    set search_path = pg_catalog, admin, public
    as $$
    declare
      v_action text;
    begin
      if tg_op = 'INSERT' then
        v_action := case when new.deleted_at is not null then 'deleted' else 'created' end;
      else
        -- Only a real change is history. A sweep that re-upserts an unchanged
        -- record touches indexed_at and nothing else, and must not write a row.
        if old.cid is not distinct from new.cid
           and old.rev is not distinct from new.rev
           and old.deleted_at is not distinct from new.deleted_at then
          return null;
        end if;

        if old.deleted_at is null and new.deleted_at is not null then
          v_action := 'deleted';
        elsif old.deleted_at is not null and new.deleted_at is null then
          v_action := 'restored';
        else
          v_action := 'updated';
        end if;
      end if;

      insert into admin.atproto_record_revision (
        did, rkey, collection, uri, cid, rev, record, name,
        record_created_at, record_updated_at, validation_status, action
      )
      values (
        new.did, new.rkey, new.collection, new.uri, new.cid, new.rev,
        case when v_action = 'deleted' then null else new.record end,
        new.name, new.record_created_at, new.record_updated_at,
        new.validation_status, v_action
      );

      -- AFTER trigger: the return value is ignored, but plpgsql wants one.
      return null;
    end;
    $$;
  `.execute(db);

  await sql`
    create trigger atproto_collection_recipe_capture_revision
    after insert or update on public.atproto_collection_recipe
    for each row
    execute function admin.capture_atproto_record_revision();
  `.execute(db);

  // Seed the table with the current state of the index, so a record that has
  // not changed since the sweep first saw it still has something to show. These
  // are marked `backfill`, never `created` — see the column comment.
  await sql`
    insert into admin.atproto_record_revision (
      did, rkey, collection, uri, cid, rev, record, name,
      record_created_at, record_updated_at, validation_status, action, observed_at
    )
    select did, rkey, collection, uri, cid, rev, record, name,
           record_created_at, record_updated_at, validation_status, 'backfill', indexed_at
    from public.atproto_collection_recipe;
  `.execute(db);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop trigger if exists atproto_collection_recipe_capture_revision on public.atproto_collection_recipe;`.execute(db);
  await sql`drop function if exists admin.capture_atproto_record_revision();`.execute(db);
  await db.schema.withSchema("admin").dropTable("atproto_record_revision").ifExists().execute();
}
