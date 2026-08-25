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
import { listLocalRecipes, type LocalRecipeRow } from "#/server/local-recipes";

/**
 * `public.recipe` — what Postgres holds, from the local side.
 *
 * The column that earns this page its place is **On network**: a published
 * recipe whose `(did, rkey)` the sweep has never seen is a recipe the user
 * believes they shared and nobody can find. That mismatch is invisible from the
 * network browser, which only lists records that exist.
 */
const searchSchema = z.object({
  q: z.string().optional(),
  origin: z.string().optional(),
  state: z.enum(["all", "published", "local"]).default("all"),
  page: z.number().int().min(0).default(0),
});

const PAGE_SIZE = 50;

function localQuery(search: z.infer<typeof searchSchema>) {
  return queryOptions({
    queryKey: ["local-recipes", search],
    queryFn: () =>
      listLocalRecipes({ data: { search: search.q || undefined, origin: search.origin || undefined, state: search.state, limit: PAGE_SIZE, offset: search.page * PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
}

export const Route = createFileRoute("/_authed/local/recipes/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(localQuery(deps)),
  component: LocalRecipes,
});

function LocalRecipes() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data, isFetching } = useQuery(localQuery(search));

  // Local draft, debounced into `?q=`. See `useSearchDraft` for why this is not
  // a `useState` + `useEffect` pair.
  const [draft, setDraft] = useSearchDraft(search.q ?? "", (next) => {
    void navigate({ search: (prev) => ({ ...prev, q: next || undefined, page: 0 }) });
  });

  const columns = useMemo<ColumnDef<LocalRecipeRow, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-0 space-y-1">
            <Link to="/local/recipes/$id" params={{ id: row.original.id }} className="block max-w-[28rem] truncate font-medium underline-offset-4 hover:underline">
              {row.original.name}
            </Link>
            <span className="block font-mono text-[11px] text-muted-foreground">{row.original.id}</span>
          </div>
        ),
      },
      { id: "origin", header: "Origin", enableSorting: false, cell: ({ row }) => <Badge variant="outline">{row.original.origin}</Badge> },
      { id: "visibility", header: "Visibility", enableSorting: false, cell: ({ row }) => <span className="text-xs">{row.original.visibility}</span> },
      {
        id: "record",
        header: "ATProto record",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.did && row.original.rkey ? (
            <Link
              to="/network/recipes/$did/$rkey"
              params={{ did: row.original.did, rkey: row.original.rkey }}
              className="text-xs underline underline-offset-4"
              title={row.original.did}
            >
              {shortDid(row.original.did)}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">not published</span>
          ),
      },
      {
        id: "on_network",
        header: "On network",
        enableSorting: false,
        cell: ({ row }) =>
          !row.original.rkey ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : row.original.on_network ? (
            <Badge variant="secondary">indexed</Badge>
          ) : (
            // The finding this page exists for: published locally, invisible to
            // the sweep.
            <Badge variant="destructive">not indexed</Badge>
          ),
      },
      { id: "boxes", header: "In boxes", enableSorting: false, cell: ({ row }) => <span className="text-xs">{count(row.original.box_count)}</span> },
      {
        id: "record_updated_at",
        header: "Record updated",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap" title={absoluteTime(row.original.record_updated_at)}>
            {relativeTime(row.original.record_updated_at)}
          </span>
        ),
      },
      {
        id: "indexed_at",
        header: "Row created",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap" title={absoluteTime(row.original.indexed_at)}>
            {relativeTime(row.original.indexed_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Local recipes" description="The public.recipe table, unfiltered by household. This is what Postgres holds, whether or not the network agrees." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 lg:col-span-2">
          <Label htmlFor="search">Name contains</Label>
          <Input id="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Search recipe names…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="state">Publish state</Label>
          <Select
            value={search.state}
            onValueChange={(value) => void navigate({ search: (prev) => ({ ...prev, state: value as z.infer<typeof searchSchema>["state"], page: 0 }) })}
          >
            <SelectTrigger id="state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="published">Has an rkey</SelectItem>
              <SelectItem value="local">Local only</SelectItem>
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
        emptyMessage="No recipes match these filters."
        onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
      />
    </div>
  );
}
