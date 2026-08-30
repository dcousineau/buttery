import { Link, createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { absoluteTime, count, relativeTime } from "#/lib/format";
import { getOverview, type OverviewStats } from "#/server/overview";

const overviewQuery = queryOptions({
  queryKey: ["overview"],
  queryFn: () => getOverview(),
});

export const Route = createFileRoute("/_authed/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery),
  component: Dashboard,
});

/** One number, its label, and a line saying what it means. */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={tone === "warn" ? "text-2xl text-destructive" : "text-2xl"}>{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Dashboard() {
  const { data } = useSuspenseQuery(overviewQuery);
  const stats: OverviewStats = data;

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Counts across the shared database, and how the last atproto sweep went. Everything here is read-only." />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Network records" value={count(stats.networkRecords)} hint={`${count(stats.networkRecordsDeleted)} tombstoned`} />
        <Stat
          label="Invalid records"
          value={count(stats.networkRecordsInvalid)}
          hint="Failed lexicon validation at sweep time"
          tone={stats.networkRecordsInvalid > 0 ? "warn" : undefined}
        />
        <Stat label="Tracked repos" value={count(stats.repos)} hint={`${count(stats.reposErrored)} with a last_error`} tone={stats.reposErrored > 0 ? "warn" : undefined} />
        <Stat label="Observed changes (24h)" value={count(stats.observedChanges24h)} hint="Excludes the one-off backfill" />
        <Stat label="Local recipes" value={count(stats.localRecipes)} hint={`${count(stats.localPublished)} carry an atproto rkey`} />
        <Stat label="Households" value={count(stats.households)} hint="Not soft-deleted" />
        <Stat label="App users" value={count(stats.appUsers)} hint="public.user — cooks, not operators" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Last sync run</CardTitle>
          <CardDescription>
            Written by <code className="font-mono text-xs">services/atproto-cron-sync</code>. A sweep that never finished leaves this row{" "}
            <code className="font-mono text-xs">running</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stats.lastSweep ? (
            <dl className="grid gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd className="mt-1">
                  <Badge variant={stats.lastSweep.status === "ok" ? "secondary" : stats.lastSweep.status === "running" ? "outline" : "destructive"}>{stats.lastSweep.status}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Started</dt>
                <dd className="mt-1 text-sm" title={absoluteTime(stats.lastSweep.started_at)}>
                  {relativeTime(stats.lastSweep.started_at)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Finished</dt>
                <dd className="mt-1 text-sm" title={absoluteTime(stats.lastSweep.finished_at)}>
                  {stats.lastSweep.finished_at ? relativeTime(stats.lastSweep.finished_at) : "still running"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Repos failed</dt>
                <dd className="mt-1 text-sm">{count(stats.lastSweep.repos_failed)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              No sweep has ever run against this database. Start one with <code className="font-mono text-xs">pnpm --filter @buttery/atproto-cron-sync sync:once</code>.
            </p>
          )}
          <p className="mt-4 text-sm">
            <Link to="/network/sync-runs" className="underline underline-offset-4">
              All sync runs
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
