import { createFileRoute, redirect } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { PageHeader } from "#/components/PageHeader";
import { RowTable, renderCell } from "#/components/RecordTables";
import { Badge } from "#/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { absoluteTime, count, relativeTime } from "#/lib/format";
import { asText } from "#/lib/record-shape";
import { getLocalRecipe } from "#/server/local-recipes";

/**
 * A local recipe that was never published.
 *
 * A recipe that *does* carry a `(did, rkey)` is redirected to
 * `/network/recipes/$did/$rkey` instead, because that page already shows both
 * copies side by side — and a second detail page showing one of them would be
 * a slower way to see less. Only the local-only case renders here, and it says
 * so at the top rather than leaving a reader to wonder where the network tab
 * went.
 */
const localQuery = (id: string) =>
  queryOptions({
    queryKey: ["local-recipe", id],
    queryFn: () => getLocalRecipe({ data: { id } }),
  });

export const Route = createFileRoute("/_authed/local/recipes/$id")({
  loader: async ({ context, params }) => {
    const detail = await context.queryClient.ensureQueryData(localQuery(params.id));
    const did = detail?.tables.recipe.did as string | null | undefined;
    const rkey = detail?.tables.recipe.rkey as string | null | undefined;
    if (did && rkey) {
      throw redirect({ to: "/network/recipes/$did/$rkey", params: { did, rkey } });
    }
    return detail;
  },
  component: LocalRecipeDetailPage,
});

function LocalRecipeDetailPage() {
  const { id } = Route.useParams();
  const { data } = useSuspenseQuery(localQuery(id));

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No such recipe</CardTitle>
          <CardDescription>
            Nothing in <code className="font-mono text-xs">public.recipe</code> has id <code className="font-mono text-xs">{id}</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { tables } = data;

  return (
    <div className="space-y-6">
      <PageHeader title={asText(tables.recipe.name, id)} description={<span className="font-mono text-xs [overflow-wrap:anywhere]">{id}</span>} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{asText(tables.recipe.origin)}</Badge>
        <Badge variant="secondary">{asText(tables.recipe.visibility)}</Badge>
        <Badge variant="outline">local only — no atproto record</Badge>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">recipe</h2>
        <RowTable row={tables.recipe} />
      </section>

      <OrdinalTable title="recipe_ingredient" rows={tables.ingredients} />
      <OrdinalTable title="recipe_instruction" rows={tables.instructions} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">recipe_image</h2>
        {tables.images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No image rows.</p>
        ) : (
          tables.images.map((image) => <RowTable key={asText(image.ordinal)} row={image} />)
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">recipe_keyword</h2>
        <p className="text-sm">{tables.keywords.length > 0 ? tables.keywords.join(", ") : <span className="text-muted-foreground">No keywords.</span>}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">recipe_attribution</h2>
        <RowTable row={tables.attribution} emptyMessage="No attribution row." />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">recipe_meta</h2>
        {tables.meta.length === 0 ? (
          <p className="text-sm text-muted-foreground">No meta rows.</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ns</TableHead>
                  <TableHead>key</TableHead>
                  <TableHead>value</TableHead>
                  <TableHead>updated_at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.meta.map((row) => (
                  <TableRow key={`${row.ns}/${row.key}`}>
                    <TableCell className="font-mono text-xs">{row.ns}</TableCell>
                    <TableCell className="font-mono text-xs">{row.key}</TableCell>
                    <TableCell className="text-xs [overflow-wrap:anywhere]">{renderCell(row.value)}</TableCell>
                    <TableCell className="text-xs" title={absoluteTime(row.updated_at)}>
                      {relativeTime(row.updated_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">household_recipe — who has this in their box</h2>
        {tables.boxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No household has filed this recipe.</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Household</TableHead>
                  <TableHead>household_id</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Favorite</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.boxes.map((box) => (
                  <TableRow key={box.household_id}>
                    <TableCell className="text-xs">{box.household_name ?? <span className="text-muted-foreground">(deleted)</span>}</TableCell>
                    <TableCell className="font-mono text-xs">{box.household_id}</TableCell>
                    <TableCell className="text-xs" title={absoluteTime(box.added_at)}>
                      {relativeTime(box.added_at)}
                    </TableCell>
                    <TableCell className="text-xs">{box.favorite ? "yes" : "no"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function OrdinalTable({ title, rows }: { title: string; rows: Array<{ ordinal: number; text: string }> }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({count(rows.length)})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No rows.</p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">ordinal</TableHead>
                <TableHead>text</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.ordinal}>
                  <TableCell className="font-mono text-xs align-top">{row.ordinal}</TableCell>
                  <TableCell className="text-xs align-top whitespace-pre-wrap">{row.text}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
