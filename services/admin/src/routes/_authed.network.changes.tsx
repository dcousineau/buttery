import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { z } from "zod";
import { DataTable } from "#/components/DataTable";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { Label } from "#/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "#/components/ui/select";
import { absoluteTime, relativeTime, shortDid, shortHash } from "#/lib/format";
import { listNetworkChanges, type NetworkChangeRow } from "#/server/network-recipes";

/**
 * "What changed recently, anywhere on the network."
 *
 * Reads `admin.atproto_record_revision` — the observed-change log the admin
 * revision trigger writes. Note the honest limitation, repeated in the page
 * copy: this is what *we saw on a sweep*, at sweep granularity. Two edits
 * between sweeps land here as one row.
 */
const searchSchema = z.object({
  action: z.enum(["all", "created", "updated", "deleted", "restored"]).default("all"),
  backfill: z.boolean().default(false),
  page: z.number().int().min(0).default(0),
});

const PAGE_SIZE = 50;

function changesQuery(search: z.infer<typeof searchSchema>) {
  return queryOptions({
    queryKey: ["network-changes", search],
    queryFn: () => listNetworkChanges({ data: { action: search.action, includeBackfill: search.backfill, limit: PAGE_SIZE, offset: search.page * PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
}

export const Route = createFileRoute("/_authed/network/changes")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(changesQuery(deps)),
  component: NetworkChanges,
});

function NetworkChanges() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isFetching } = useQuery(changesQuery(search));

  const columns = useMemo<ColumnDef<NetworkChangeRow, unknown>[]>(
    () => [
      {
        id: "observed_at",
        header: "Observed",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap" title={absoluteTime(row.original.observed_at)}>
            {relativeTime(row.original.observed_at)}
          </span>
        ),
      },
      {
        id: "action",
        header: "Action",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.action === "deleted" ? "destructive" : row.original.action === "backfill" ? "outline" : "secondary"}>{row.original.action}</Badge>
        ),
      },
      {
        id: "name",
        header: "Record",
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            to="/network/recipes/$did/$rkey"
            params={{ did: row.original.did, rkey: row.original.rkey }}
            className="block max-w-[24rem] truncate underline-offset-4 hover:underline"
          >
            {row.original.name ?? <span className="text-muted-foreground italic">(no name)</span>}
          </Link>
        ),
      },
      {
        id: "did",
        header: "Repo",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs" title={row.original.did}>
            {row.original.handle ? `@${row.original.handle}` : shortDid(row.original.did)}
          </span>
        ),
      },
      {
        id: "cid",
        header: "CID",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground" title={row.original.cid}>
            {shortHash(row.original.cid)}
          </span>
        ),
      },
      {
        id: "rev",
        header: "rev",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground" title={row.original.rev}>
            {shortHash(row.original.rev)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Recent changes" description="Every record change the sweep has observed, newest first. Sweep granularity — two edits between sweeps arrive as one row." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="action">Action</Label>
          <Select
            value={search.action}
            onValueChange={(value) => void navigate({ search: (prev) => ({ ...prev, action: value as z.infer<typeof searchSchema>["action"], page: 0 }) })}
          >
            <SelectTrigger id="action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="updated">Updated</SelectItem>
              <SelectItem value="deleted">Deleted</SelectItem>
              <SelectItem value="restored">Restored</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="backfill">Backfill rows</Label>
          <Select value={search.backfill ? "yes" : "no"} onValueChange={(value) => void navigate({ search: (prev) => ({ ...prev, backfill: value === "yes", page: 0 }) })}>
            <SelectTrigger id="backfill">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="no">Hidden</SelectItem>
              <SelectItem value="yes">Shown</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={data?.rows ?? []}
        total={data?.total ?? 0}
        pageIndex={search.page}
        pageSize={PAGE_SIZE}
        isLoading={isFetching}
        emptyMessage="Nothing observed yet. The trigger records a row the next time a sweep changes a record."
        onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
      />
    </div>
  );
}
