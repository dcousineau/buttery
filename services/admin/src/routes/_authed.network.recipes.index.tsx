import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { z } from "zod";
import { DataTable } from "#/components/DataTable";
import { PageHeader } from "#/components/PageHeader";
import { Badge } from "#/components/ui/badge";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "#/components/ui/select";
import { absoluteTime, count, relativeTime, shortDid, shortHash } from "#/lib/format";
import { useSearchDraft } from "#/lib/use-search-draft";
import { listNetworkRecipes, type NetworkRecipeRow } from "#/server/network-recipes";

/**
 * The raw `atproto_collection_recipe` browser — every `exchange.recipe.recipe`
 * record the sweep has seen, as the sweep stored it.
 *
 * **All table state lives in the URL.** Page, sort, search and every filter are
 * search params, which means a row an operator is looking at is a link they can
 * paste into a ticket, and a reload does not throw away the filter that took
 * three tries to get right. It also makes the query key trivially correct:
 * the params *are* the key.
 */
const searchSchema = z.object({
  q: z.string().optional(),
  did: z.string().optional(),
  validation: z.enum(["all", "valid", "invalid", "unknown"]).default("all"),
  presence: z.enum(["live", "deleted", "all"]).default("live"),
  pairing: z.enum(["all", "both", "network-only"]).default("all"),
  sort: z.enum(["indexed_at", "record_updated_at", "record_created_at", "name", "did"]).default("record_updated_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(0).default(0),
});

type RecipeSearch = z.infer<typeof searchSchema>;

const PAGE_SIZE = 50;

function listQuery(search: RecipeSearch) {
  return queryOptions({
    queryKey: ["network-recipes", search],
    queryFn: () =>
      listNetworkRecipes({
        data: {
          search: search.q || undefined,
          did: search.did || undefined,
          validation: search.validation,
          presence: search.presence,
          pairing: search.pairing,
          sort: search.sort,
          dir: search.dir,
          limit: PAGE_SIZE,
          offset: search.page * PAGE_SIZE,
        },
      }),
    // Paging without this blanks the table on every click; with it the previous
    // page stays put (dimmed by `DataTable`) until the next one lands.
    placeholderData: keepPreviousData,
  });
}

export const Route = createFileRoute("/_authed/network/recipes/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(listQuery(deps)),
  component: NetworkRecipes,
});

function NetworkRecipes() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isFetching } = useQuery(listQuery(search));

  // Local draft, debounced into `?q=`. See `useSearchDraft` for why this is not
  // a `useState` + `useEffect` pair.
  const [draft, setDraft] = useSearchDraft(search.q ?? "", (next) => {
    void navigate({ search: (prev) => ({ ...prev, q: next || undefined, page: 0 }) });
  });

  const setFilter = <K extends keyof RecipeSearch>(key: K, value: RecipeSearch[K]) => {
    // Any filter change resets to page 0 — staying on page 7 of a result set
    // that now has two pages shows an empty table and looks like a bug.
    void navigate({ search: (prev) => ({ ...prev, [key]: value, page: 0 }) });
  };

  const sorting: SortingState = [{ id: search.sort, desc: search.dir === "desc" }];

  const columns = useMemo<ColumnDef<NetworkRecipeRow, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        accessorFn: (row) => row.name,
        cell: ({ row }) => (
          <div className="min-w-0 space-y-1">
            <Link
              to="/network/recipes/$did/$rkey"
              params={{ did: row.original.did, rkey: row.original.rkey }}
              className="block max-w-[28rem] truncate font-medium underline-offset-4 hover:underline"
            >
              {row.original.name ?? <span className="text-muted-foreground italic">(no name on record)</span>}
            </Link>
            <span className="block font-mono text-[11px] text-muted-foreground">{row.original.rkey}</span>
          </div>
        ),
      },
      {
        id: "did",
        header: "Repo",
        accessorFn: (row) => row.did,
        cell: ({ row }) => (
          <div className="space-y-1">
            <span className="block text-xs">{row.original.handle ? `@${row.original.handle}` : <span className="text-muted-foreground">unresolved handle</span>}</span>
            <span className="block font-mono text-[11px] text-muted-foreground" title={row.original.did}>
              {shortDid(row.original.did)}
            </span>
          </div>
        ),
      },
      {
        id: "pairing",
        header: "Local copy",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.local_recipe_id ? (
            <Link to="/local/recipes/$id" params={{ id: row.original.local_recipe_id }} className="text-xs underline underline-offset-4">
              {row.original.local_origin ?? "local"}
            </Link>
          ) : (
            <Badge variant="outline">network only</Badge>
          ),
      },
      {
        id: "validation",
        header: "Validation",
        enableSorting: false,
        cell: ({ row }) => {
          const status = row.original.validation_status;
          return <Badge variant={status === "valid" ? "secondary" : status === "invalid" ? "destructive" : "outline"}>{status}</Badge>;
        },
      },
      {
        id: "record_updated_at",
        header: "Record updated",
        accessorFn: (row) => row.record_updated_at,
        cell: ({ row }) => (
          <span className="text-xs" title={absoluteTime(row.original.record_updated_at)}>
            {relativeTime(row.original.record_updated_at)}
          </span>
        ),
      },
      {
        id: "indexed_at",
        header: "Last swept",
        accessorFn: (row) => row.indexed_at,
        cell: ({ row }) => (
          <span className="text-xs" title={absoluteTime(row.original.indexed_at)}>
            {relativeTime(row.original.indexed_at)}
          </span>
        ),
      },
      {
        id: "revisions",
        header: "Revisions",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs" title={row.original.last_change_at ? `last observed change ${absoluteTime(row.original.last_change_at)}` : "no change observed since backfill"}>
            {count(row.original.revision_count)}
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
        id: "state",
        header: "State",
        enableSorting: false,
        cell: ({ row }) => (row.original.deleted_at ? <Badge variant="destructive">tombstoned</Badge> : <Badge variant="secondary">live</Badge>),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recipe records"
        description={
          <>
            Raw <code className="font-mono text-xs">exchange.recipe.recipe</code> records from <code className="font-mono text-xs">atproto_collection_recipe</code>, exactly as the
            sweep stored them. Nothing here is merged with the local copy.
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="search">Name contains</Label>
          <Input id="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search record names…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="validation">Validation</Label>
          <Select value={search.validation} onValueChange={(value) => setFilter("validation", value as RecipeSearch["validation"])}>
            <SelectTrigger id="validation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="valid">Valid</SelectItem>
              <SelectItem value="invalid">Invalid</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="presence">Presence</Label>
          <Select value={search.presence} onValueChange={(value) => setFilter("presence", value as RecipeSearch["presence"])}>
            <SelectTrigger id="presence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="deleted">Tombstoned</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pairing">Local copy</Label>
          <Select value={search.pairing} onValueChange={(value) => setFilter("pairing", value as RecipeSearch["pairing"])}>
            <SelectTrigger id="pairing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any</SelectItem>
              <SelectItem value="both">Has a local row</SelectItem>
              <SelectItem value="network-only">Network only</SelectItem>
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
        emptyMessage="No records match these filters."
        onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
        sorting={sorting}
        onSortingChange={(updater) => {
          const next = typeof updater === "function" ? updater(sorting) : updater;
          const first = next[0];
          if (!first) return;
          void navigate({
            search: (prev) => ({ ...prev, sort: first.id as RecipeSearch["sort"], dir: first.desc ? "desc" : "asc", page: 0 }),
          });
        }}
      />
    </div>
  );
}
