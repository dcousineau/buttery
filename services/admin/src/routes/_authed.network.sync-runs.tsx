import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { z } from "zod";
import { DataTable } from "#/components/DataTable";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { absoluteTime, count, duration, relativeTime } from "#/lib/format";
import { listSyncRuns, type SyncRunRow } from "#/server/network-health";

/**
 * `atproto_sync_run`, newest first — one row per sweep. A row still marked
 * `running` long after it started is a sweep that died without writing its
 * finish, which is the drift alarm the table was added for.
 */
const searchSchema = z.object({ page: z.number().int().min(0).default(0) });

const PAGE_SIZE = 50;

function runsQuery(search: z.infer<typeof searchSchema>) {
  return queryOptions({
    queryKey: ["sync-runs", search],
    queryFn: () => listSyncRuns({ data: { limit: PAGE_SIZE, offset: search.page * PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
}

export const Route = createFileRoute("/_authed/network/sync-runs")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(runsQuery(deps)),
  component: SyncRuns,
});

function SyncRuns() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isFetching } = useQuery(runsQuery(search));

  const columns = useMemo<ColumnDef<SyncRunRow, unknown>[]>(
    () => [
      {
        id: "started_at",
        header: "Started",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap" title={absoluteTime(row.original.started_at)}>
            {relativeTime(row.original.started_at)}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.status === "ok" ? "secondary" : row.original.status === "running" ? "outline" : "destructive"}>{row.original.status}</Badge>
        ),
      },
      { id: "duration", header: "Duration", enableSorting: false, cell: ({ row }) => <span className="text-xs">{duration(row.original.duration_ms)}</span> },
      { id: "repos_seen", header: "Repos", enableSorting: false, cell: ({ row }) => <span className="text-xs">{count(row.original.repos_seen)}</span> },
      { id: "records_upserted", header: "Upserted", enableSorting: false, cell: ({ row }) => <span className="text-xs">{count(row.original.records_upserted)}</span> },
      { id: "records_deleted", header: "Deleted", enableSorting: false, cell: ({ row }) => <span className="text-xs">{count(row.original.records_deleted)}</span> },
      {
        id: "repos_failed",
        header: "Failed",
        enableSorting: false,
        cell: ({ row }) => <span className={row.original.repos_failed > 0 ? "text-xs text-destructive" : "text-xs"}>{count(row.original.repos_failed)}</span>,
      },
      {
        id: "error",
        header: "Error",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.error ? (
            <span className="block max-w-[28rem] text-xs text-destructive [overflow-wrap:anywhere]">{row.original.error}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Sync runs" description="One row per sweep, written by services/atproto-cron-sync. A stuck `running` row means a sweep died without finishing." />
      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        total={data?.total ?? 0}
        pageIndex={search.page}
        pageSize={PAGE_SIZE}
        isLoading={isFetching}
        emptyMessage="No sweep has ever run against this database."
        onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
      />
    </div>
  );
}
