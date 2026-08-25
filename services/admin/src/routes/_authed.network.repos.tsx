import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { z } from "zod";
import { DataTable } from "#/components/DataTable";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "#/components/ui/select";
import { absoluteTime, count, relativeTime, shortDid } from "#/lib/format";
import { useSearchDraft } from "#/lib/use-search-draft";
import { listRepos, type RepoRow } from "#/server/network-health";

/**
 * The repos the sweep tracks. Open this when the record browser looks stale:
 * one repo with a `last_error` is a PDS problem, every repo stale at once is a
 * sweep problem, and the record index alone cannot tell those apart.
 */
const searchSchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  errored: z.boolean().default(false),
  page: z.number().int().min(0).default(0),
});

const PAGE_SIZE = 50;

function reposQuery(search: z.infer<typeof searchSchema>) {
  return queryOptions({
    queryKey: ["repos", search],
    queryFn: () =>
      listRepos({ data: { search: search.q || undefined, status: search.status || undefined, erroredOnly: search.errored, limit: PAGE_SIZE, offset: search.page * PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
}

export const Route = createFileRoute("/_authed/network/repos")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(reposQuery(deps)),
  component: Repos,
});

function Repos() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isFetching } = useQuery(reposQuery(search));

  // Local draft, debounced into `?q=`. See `useSearchDraft` for why this is not
  // a `useState` + `useEffect` pair.
  const [draft, setDraft] = useSearchDraft(search.q ?? "", (next) => {
    void navigate({ search: (prev) => ({ ...prev, q: next || undefined, page: 0 }) });
  });

  const columns = useMemo<ColumnDef<RepoRow, unknown>[]>(
    () => [
      {
        id: "handle",
        header: "Repo",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="space-y-1">
            <Link
              to="/network/recipes"
              search={{ did: row.original.did, validation: "all", presence: "all", pairing: "all", sort: "record_updated_at", dir: "desc", page: 0 }}
              className="block font-medium underline-offset-4 hover:underline"
            >
              {row.original.handle ? `@${row.original.handle}` : shortDid(row.original.did)}
            </Link>
            <span className="block font-mono text-[11px] text-muted-foreground" title={row.original.did}>
              {shortDid(row.original.did)}
            </span>
          </div>
        ),
      },
      { id: "pds", header: "PDS", enableSorting: false, cell: ({ row }) => <span className="text-xs [overflow-wrap:anywhere]">{row.original.pds ?? "—"}</span> },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => <Badge variant={row.original.status === "active" ? "secondary" : "outline"}>{row.original.status}</Badge>,
      },
      {
        id: "records",
        header: "Records",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs" title={`${count(row.original.record_count)} total, ${count(row.original.record_count - row.original.live_record_count)} tombstoned`}>
            {count(row.original.live_record_count)} live
          </span>
        ),
      },
      {
        id: "last_synced_at",
        header: "Last swept",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap" title={absoluteTime(row.original.last_synced_at)}>
            {relativeTime(row.original.last_synced_at)}
          </span>
        ),
      },
      {
        id: "missing_since",
        header: "Missing since",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.missing_since ? (
            <span className="text-xs whitespace-nowrap text-destructive" title={absoluteTime(row.original.missing_since)}>
              {relativeTime(row.original.missing_since)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "last_error",
        header: "Last error",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.last_error ? (
            <span className="block max-w-[24rem] text-xs text-destructive [overflow-wrap:anywhere]">{row.original.last_error}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Repos" description="Every DID the sweep tracks, with its PDS, its record counts and whatever went wrong last time." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="search">Handle or DID contains</Label>
          <Input id="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="chef.test, did:plc:…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="errored">Errors</Label>
          <Select value={search.errored ? "errored" : "all"} onValueChange={(value) => void navigate({ search: (prev) => ({ ...prev, errored: value === "errored", page: 0 }) })}>
            <SelectTrigger id="errored">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repos</SelectItem>
              <SelectItem value="errored">With a last_error</SelectItem>
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
        emptyMessage="No repos tracked. Run a sweep to discover some."
        onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
      />
    </div>
  );
}
