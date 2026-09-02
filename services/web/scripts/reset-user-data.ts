/**
 * Wipe every user-owned row from the local database, leaving the atproto index
 * intact.
 *
 *   pnpm --filter @buttery/web db:reset:users -- --dry-run
 *   pnpm --filter @buttery/web db:reset:users -- --yes
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Onboarding — sign-in, household creation, the first-run flow — is only
 * honestly testable from zero. But "from zero" via `db:migrate:down`/`up` also
 * throws away the synced atproto corpus (~4k recipes at time of writing), which
 * costs a full `sync:trigger` sweep to rebuild and has nothing to do with the
 * account being reset. So this deletes the account/household half of the schema
 * and deliberately leaves the network-index half alone.
 *
 * ── WHAT IS KEPT ────────────────────────────────────────────────────────────
 *
 *   atproto_repo, atproto_collection_recipe, atproto_sync_run — the crawl index
 *   recipe (origin = 'sync') + its children                   — synced recipes
 *   recipe_vocab, recipe_vocab_alias                          — reference data
 *
 * A synced recipe survives even when a household had it boxed or planned; only
 * the boxing and the plan entry go away. `origin = 'local'` recipes are ones a
 * human created or imported here, so they are user data and they go.
 *
 * ── WHAT IS NOT HANDLED ─────────────────────────────────────────────────────
 *
 * Blob storage. Hero images for deleted local recipes
 * (`recipe_pending_image.object_key`) and any browser uploads no save ever
 * claimed are orphaned under `uploads/`, not deleted — this script only speaks
 * SQL. In local dev that is a few stray objects; nobody pays for them and
 * nothing reads them.
 *
 * Redis. The scrape rate limiter and cache are keyed by DID/host and will still
 * hold entries for the deleted user. They expire on their own.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Destructive and not undoable, so: nothing happens without `--yes`, and a
 * DATABASE_URL that is not loopback is refused outright unless `--allow-remote`
 * is also passed. There is no way to run this by accident, and no process, hook
 * or task may be taught to call it — same contract as the seeds next door.
 */
import { getPool } from "../src/lib/db.ts";

// `.env` lives in this package (services/web) and nothing injects it for a bare
// `node` script — same situation, and same fix, as kysely.config.ts.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — rely on the ambient environment.
}

/** Hosts we consider "a local dev database" for the --allow-remote gate. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/**
 * Deletes, in foreign-key-safe order (children first).
 *
 * Several of these FKs cascade, so deleting the parent alone would be enough to
 * clear the table — but then the cascaded rows never pass through a DELETE we
 * can count, and the summary would under-report. Explicit children first means
 * every number printed is a number this script actually deleted.
 */
const LOCAL_RECIPES = "select id from recipe where origin <> 'sync'";

const DELETIONS: { table: string; sql: string }[] = [
  // Household-scoped content.
  { table: "grocery_item_source", sql: "delete from grocery_item_source" },
  { table: "grocery_item", sql: "delete from grocery_item" },
  { table: "household_recipe_note", sql: "delete from household_recipe_note" },
  { table: "household_recipe_meta", sql: "delete from household_recipe_meta" },
  { table: "household_recipe", sql: "delete from household_recipe" },
  { table: "meal_plan_entry", sql: "delete from meal_plan_entry" },
  { table: "household_invite", sql: "delete from household_invite" },
  { table: "household_preference", sql: "delete from household_preference" },
  { table: "household_member", sql: "delete from household_member" },

  // Import bookkeeping. `recipe_import_session.household_id` is ON DELETE NO
  // ACTION, so these must precede `household` or the household delete errors.
  { table: "recipe_import_skip", sql: "delete from recipe_import_skip" },
  { table: "recipe_import_session", sql: "delete from recipe_import_session" },
  { table: "recipe_import_attempt", sql: "delete from recipe_import_attempt" },

  { table: "household", sql: "delete from household" },

  // Locally created/imported recipes and everything hanging off them. The
  // subquery is re-evaluated per statement; the recipe rows themselves are
  // deleted last, so it still selects the same set each time.
  { table: "recipe_search (local)", sql: `delete from recipe_search where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_meta (local)", sql: `delete from recipe_meta where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_keyword (local)", sql: `delete from recipe_keyword where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_instruction (local)", sql: `delete from recipe_instruction where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_ingredient (local)", sql: `delete from recipe_ingredient where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_image (local)", sql: `delete from recipe_image where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_attribution (local)", sql: `delete from recipe_attribution where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe_pending_image (local)", sql: `delete from recipe_pending_image where recipe_id in (${LOCAL_RECIPES})` },
  { table: "recipe (local)", sql: "delete from recipe where origin <> 'sync'" },

  // Scrape cache: keyed by URL, holds no user rows, but it is what makes a
  // re-run of an import silently skip the network. Clearing it keeps a repeated
  // onboarding test honest.
  { table: "recipe_fetch_cache", sql: "delete from recipe_fetch_cache" },

  // Auth. `atproto_oauth_*` are the OAuth client's session/state stores — user
  // credentials, despite the prefix. They are NOT part of the crawl index.
  { table: "session", sql: "delete from session" },
  { table: "account", sql: "delete from account" },
  { table: "verification", sql: "delete from verification" },
  { table: "user", sql: 'delete from "user"' },
  { table: "atproto_oauth_session", sql: "delete from atproto_oauth_session" },
  { table: "atproto_oauth_state", sql: "delete from atproto_oauth_state" },
];

/** Read back afterwards, to prove the atproto half is still there. */
const PRESERVED = [
  { label: "recipe (origin='sync')", sql: "select count(*)::int as n from recipe where origin = 'sync'" },
  { label: "atproto_collection_recipe", sql: "select count(*)::int as n from atproto_collection_recipe" },
  { label: "atproto_repo", sql: "select count(*)::int as n from atproto_repo" },
  { label: "atproto_sync_run", sql: "select count(*)::int as n from atproto_sync_run" },
  { label: "recipe_vocab", sql: "select count(*)::int as n from recipe_vocab" },
];

function describeTarget(url: string): { host: string; database: string } {
  const parsed = new URL(url);
  return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, "") };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const confirmed = args.has("--yes");
  const allowRemote = args.has("--allow-remote");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (expected services/web/.env)");
  }
  const target = describeTarget(connectionString);

  if (!LOCAL_HOSTS.has(target.host) && !allowRemote) {
    console.error(`Refusing to run: ${target.host} is not a local host.`);
    console.error("This wipes every account and household in the target database.");
    console.error("If you genuinely mean to reset a remote one, re-run with --allow-remote.");
    process.exitCode = 1;
    return;
  }

  if (!dryRun && !confirmed) {
    console.error(`Would delete all user + household data from ${target.database} on ${target.host}.`);
    console.error("Nothing was changed. Re-run with --dry-run to see the row counts, or --yes to do it.");
    process.exitCode = 1;
    return;
  }

  const mode = dryRun ? "DRY RUN" : "DELETING";
  console.log(`[${mode}] target: ${target.database} on ${target.host}\n`);

  const pool = getPool();
  const client = await pool.connect();
  let total = 0;
  try {
    // One transaction either way. A dry run does the real deletes and then
    // rolls back, which is the only way to report counts that account for the
    // statements ahead of it in the list.
    await client.query("begin");
    for (const { table, sql } of DELETIONS) {
      const result = await client.query(sql);
      const rows = result.rowCount ?? 0;
      total += rows;
      if (rows > 0) {
        console.log(`  ${String(rows).padStart(6)}  ${table}`);
      }
    }

    if (dryRun) {
      await client.query("rollback");
      console.log(`\n[DRY RUN] ${total} rows would be deleted. Rolled back; nothing changed.`);
    } else {
      await client.query("commit");
      console.log(`\nDeleted ${total} rows.`);
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  console.log("\nKept:");
  for (const { label, sql } of PRESERVED) {
    const { rows } = await pool.query<{ n: number }>(sql);
    console.log(`  ${String(rows[0]?.n ?? 0).padStart(6)}  ${label}`);
  }

  if (!dryRun) {
    console.log("\nSign in again to re-run onboarding. Blob-storage objects for deleted");
    console.log("local recipes are orphaned, not removed.");
  }

  await pool.end();
}

await main();
