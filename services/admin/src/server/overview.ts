import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "./session";

/**
 * The landing page's numbers. Deliberately a handful of counts and the last
 * sweep, not a dashboard: an operator arriving here is on their way somewhere
 * specific, and every extra tile is a query run on every visit.
 */

export interface OverviewStats {
  networkRecords: number;
  networkRecordsDeleted: number;
  networkRecordsInvalid: number;
  repos: number;
  reposErrored: number;
  localRecipes: number;
  localPublished: number;
  households: number;
  appUsers: number;
  observedChanges24h: number;
  lastSweep: { id: string; status: string; started_at: string; finished_at: string | null; repos_failed: number } | null;
}

export const getOverview = createServerFn({ method: "GET" }).handler(async (): Promise<OverviewStats> => {
  await requireAdmin();
  const { getDb } = await import("#/lib/db");
  const db = getDb();

  const [network, repos, local, households, users, changes, lastSweep] = await Promise.all([
    db
      .selectFrom("atproto_collection_recipe")
      .select((eb) => [
        eb.fn.countAll<string>().as("total"),
        eb.fn.count<string>("deleted_at").as("deleted"),
        eb.fn.sum<string>(eb.case().when("validation_status", "=", "invalid").then(1).else(0).end()).as("invalid"),
      ])
      .executeTakeFirst(),
    db
      .selectFrom("atproto_repo")
      .select((eb) => [eb.fn.countAll<string>().as("total"), eb.fn.count<string>("last_error").as("errored")])
      .executeTakeFirst(),
    db
      .selectFrom("recipe")
      .select((eb) => [eb.fn.countAll<string>().as("total"), eb.fn.count<string>("rkey").as("published")])
      .executeTakeFirst(),
    db
      .selectFrom("household")
      .where("deleted_at", "is", null)
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirst(),
    db
      .selectFrom("user")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirst(),
    db
      .selectFrom("admin.atproto_record_revision")
      .where("action", "!=", "backfill")
      .where("observed_at", ">", new Date(Date.now() - 24 * 60 * 60 * 1000))
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirst(),
    db.selectFrom("atproto_sync_run").select(["id", "status", "started_at", "finished_at", "repos_failed"]).orderBy("started_at", "desc").executeTakeFirst(),
  ]);

  return {
    networkRecords: Number(network?.total ?? 0),
    networkRecordsDeleted: Number(network?.deleted ?? 0),
    networkRecordsInvalid: Number(network?.invalid ?? 0),
    repos: Number(repos?.total ?? 0),
    reposErrored: Number(repos?.errored ?? 0),
    localRecipes: Number(local?.total ?? 0),
    localPublished: Number(local?.published ?? 0),
    households: Number(households?.n ?? 0),
    appUsers: Number(users?.n ?? 0),
    observedChanges24h: Number(changes?.n ?? 0),
    lastSweep: lastSweep
      ? {
          id: String(lastSweep.id),
          status: lastSweep.status,
          started_at: new Date(lastSweep.started_at).toISOString(),
          finished_at: lastSweep.finished_at ? new Date(lastSweep.finished_at).toISOString() : null,
          repos_failed: lastSweep.repos_failed,
        }
      : null,
  };
});
