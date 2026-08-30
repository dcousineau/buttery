import { Link, createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "#/components/PageHeader";
import { ComparisonTable, RawRecordTable, RowTable, renderCell } from "#/components/RecordTables";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { absoluteTime, count, relativeTime, shortHash } from "#/lib/format";
import { asText, compareProjections, scalarPaths } from "#/lib/record-shape";
import { getNetworkRecipe } from "#/server/network-recipes";

/**
 * One recipe, from every angle the database has.
 *
 * The page is built around a refusal: **it never resolves the two copies into
 * one**. The app's read path picks a winner between the local `recipe` row and
 * the atproto record, and that choice is invisible by design — which is fine
 * for a cook and useless for anyone asking why a recipe looks wrong. Here the
 * two sit in adjacent columns with their disagreements marked, and the raw
 * tables behind them are the evidence.
 *
 * Four tabs, in the order the questions get asked:
 *   Compare   — local vs network, field by field
 *   Record    — the atproto record as `path / type / value`
 *   Local     — the Postgres rows, unmodified
 *   Revisions — every change the sweep has observed, newest first
 */
const detailQuery = (did: string, rkey: string) =>
  queryOptions({
    queryKey: ["network-recipe", did, rkey],
    queryFn: () => getNetworkRecipe({ data: { did, rkey } }),
  });

export const Route = createFileRoute("/_authed/network/recipes/$did/$rkey")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(detailQuery(params.did, params.rkey)),
  component: RecordDetail,
});

function RecordDetail() {
  const { did, rkey } = Route.useParams();
  const { data } = useSuspenseQuery(detailQuery(did, rkey));
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  /** Which revision's payload the Revisions tab is showing. Null = none picked. */
  const [openRevision, setOpenRevision] = useState<string | null>(null);

  const networkRecord = (data.record?.record ?? null) as unknown;
  const comparison = useMemo(() => compareProjections(data.local?.projection ?? null, data.record ? scalarPaths(networkRecord) : null), [data.local, data.record, networkRecord]);

  const differing = comparison.filter((row) => row.status === "differs").length;
  const localId = (data.local?.tables.recipe.id as string | undefined) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={asText(data.record?.name) || (data.local?.projection.name ?? rkey)}
        description={<span className="font-mono text-xs [overflow-wrap:anywhere]">{asText(data.record?.uri, `at://${did}/exchange.recipe.recipe/${rkey}`)}</span>}
        actions={
          <div className="flex items-center gap-2">
            {localId ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/local/recipes/$id" params={{ id: localId }}>
                  Local row
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link to="/network/recipes" search={{ did, validation: "all", presence: "all", pairing: "all", sort: "record_updated_at", dir: "desc", page: 0 }}>
                All records in this repo
              </Link>
            </Button>
          </div>
        }
      />

      {/* The headline finding, before any table: which sides exist at all. */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={data.record ? "secondary" : "destructive"}>{data.record ? "on the network" : "no network record"}</Badge>
        <Badge variant={data.local ? "secondary" : "outline"}>{data.local ? "stored locally" : "no local row"}</Badge>
        {data.record?.deleted_at ? <Badge variant="destructive">tombstoned {relativeTime(asText(data.record.deleted_at))}</Badge> : null}
        {data.record ? <Badge variant={data.record.validation_status === "valid" ? "secondary" : "destructive"}>validation: {asText(data.record.validation_status)}</Badge> : null}
        {data.local && data.record ? <Badge variant={differing > 0 ? "destructive" : "secondary"}>{differing > 0 ? `${differing} field(s) differ` : "copies agree"}</Badge> : null}
      </div>

      {!data.record && data.local ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Local row claims a record the sweep has never seen</CardTitle>
            <CardDescription>
              The <code className="font-mono text-xs">recipe</code> row carries this <code className="font-mono text-xs">(did, rkey)</code> but{" "}
              <code className="font-mono text-xs">atproto_collection_recipe</code> has no matching row. Either the sweep has not reached this repo yet, or the record was published
              and then removed.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Tabs defaultValue="compare">
        <TabsList>
          <TabsTrigger value="compare">Compare</TabsTrigger>
          <TabsTrigger value="record">Record</TabsTrigger>
          <TabsTrigger value="local">Local</TabsTrigger>
          <TabsTrigger value="revisions">Revisions ({data.revisions.length})</TabsTrigger>
          <TabsTrigger value="annotations">Annotations</TabsTrigger>
        </TabsList>

        <TabsContent value="compare" className="space-y-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Both copies, field by field. Repeated fields (ingredients, instructions, images) come from whichever side has them, so a differing count shows up as rows that exist
              on one side only.
            </p>
            <Button variant="outline" size="sm" onClick={() => setOnlyDifferences((value) => !value)}>
              {onlyDifferences ? "Show all fields" : "Only differences"}
            </Button>
          </div>
          <ComparisonTable rows={comparison} showOnlyDifferences={onlyDifferences} />
        </TabsContent>

        <TabsContent value="record" className="space-y-6 pt-4">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Index row — atproto_collection_recipe</h2>
            <p className="text-xs text-muted-foreground">The sweep's own bookkeeping: identity, revision pointers, validation verdict and when we last looked.</p>
            <RowTable row={data.record ? Object.fromEntries(Object.entries(data.record).filter(([key]) => key !== "record")) : null} emptyMessage="No index row for this record." />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Record payload</h2>
            <p className="text-xs text-muted-foreground">The record as the PDS served it, flattened. Fields no lexicon we ship declares appear here too — that is the point.</p>
            <RawRecordTable value={networkRecord} emptyMessage="No record payload." />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Repo — atproto_repo</h2>
            <RowTable row={data.repo} emptyMessage="This DID is not in atproto_repo, which means the sweep found the record without ever tracking its repo." />
          </section>
        </TabsContent>

        <TabsContent value="local" className="space-y-6 pt-4">
          {data.local ? (
            <>
              <section className="space-y-2">
                <h2 className="text-sm font-semibold">recipe</h2>
                <RowTable row={data.local.tables.recipe} />
              </section>

              <OrdinalTable title="recipe_ingredient" rows={data.local.tables.ingredients} />
              <OrdinalTable title="recipe_instruction" rows={data.local.tables.instructions} />

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">recipe_image</h2>
                {data.local.tables.images.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No image rows.</p>
                ) : (
                  data.local.tables.images.map((image) => <RowTable key={asText(image.ordinal)} row={image} />)
                )}
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">recipe_keyword</h2>
                <p className="text-sm">
                  {data.local.tables.keywords.length > 0 ? data.local.tables.keywords.join(", ") : <span className="text-muted-foreground">No keywords.</span>}
                </p>
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">recipe_attribution</h2>
                <RowTable row={data.local.tables.attribution} emptyMessage="No attribution row." />
              </section>

              <section className="space-y-2">
                <h2 className="text-sm font-semibold">recipe_meta</h2>
                {data.local.tables.meta.length === 0 ? (
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
                        {data.local.tables.meta.map((row) => (
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
                {data.local.tables.boxes.length === 0 ? (
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
                        {data.local.tables.boxes.map((box) => (
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
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing in <code className="font-mono text-xs">public.recipe</code> is published as this record. The network copy is all there is.
            </p>
          )}
        </TabsContent>

        <TabsContent value="revisions" className="space-y-3 pt-4">
          <p className="text-sm text-muted-foreground">
            Every change the sweep has <em>observed</em>, newest first — not the repo's commit log, which atproto does not expose per record. A{" "}
            <code className="font-mono text-xs">backfill</code> row is the state when history started being recorded, not a change.
          </p>
          {data.revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No revisions recorded. The sweep has not written this record since history capture was added.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Observed</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>CID</TableHead>
                      <TableHead>rev</TableHead>
                      <TableHead>Record updatedAt</TableHead>
                      <TableHead>Validation</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.revisions.map((revision) => (
                      <TableRow key={revision.id} className={openRevision === revision.id ? "bg-muted/50" : undefined}>
                        <TableCell className="text-xs whitespace-nowrap" title={absoluteTime(revision.observed_at)}>
                          {relativeTime(revision.observed_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={revision.action === "deleted" ? "destructive" : revision.action === "backfill" ? "outline" : "secondary"}>{revision.action}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-[11px]" title={revision.cid}>
                          {shortHash(revision.cid)}
                        </TableCell>
                        <TableCell className="font-mono text-[11px]" title={revision.rev}>
                          {shortHash(revision.rev)}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap" title={absoluteTime(revision.record_updated_at)}>
                          {revision.record_updated_at ? relativeTime(revision.record_updated_at) : "—"}
                        </TableCell>
                        <TableCell className="text-xs">{revision.validation_status ?? "—"}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" disabled={revision.record === null} onClick={() => setOpenRevision(openRevision === revision.id ? null : revision.id)}>
                            {openRevision === revision.id ? "Hide" : "Payload"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {openRevision ? (
                <section className="space-y-2">
                  <h2 className="text-sm font-semibold">Payload as observed</h2>
                  <RawRecordTable
                    value={data.revisions.find((revision) => revision.id === openRevision)?.record ?? null}
                    emptyMessage="This revision stored no payload (a delete)."
                  />
                </section>
              ) : null}
            </div>
          )}
        </TabsContent>

        <TabsContent value="annotations" className="space-y-3 pt-4">
          {data.annotations.wired ? (
            data.annotations.annotations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No labels applied to this recipe.</p>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Namespace</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Applied by</TableHead>
                      <TableHead>Applied</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.annotations.annotations.map((annotation) => (
                      <TableRow key={`${annotation.ns}/${annotation.label}`}>
                        <TableCell className="font-mono text-xs">{annotation.ns}</TableCell>
                        <TableCell className="text-xs">{annotation.label}</TableCell>
                        <TableCell className="text-xs">{annotation.value ?? "—"}</TableCell>
                        <TableCell className="font-mono text-[11px]">{annotation.actor ?? "—"}</TableCell>
                        <TableCell className="text-xs" title={absoluteTime(annotation.applied_at)}>
                          {relativeTime(annotation.applied_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No annotation store wired up yet</CardTitle>
                <CardDescription>
                  Tagging and labelling tables are being added on another branch. When they land, give <code className="font-mono text-xs">src/server/annotations.ts</code> a real
                  body and flip <code className="font-mono text-xs">ANNOTATIONS_WIRED</code> — this tab, and the columns that read from it, then light up with no other change.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  Subject identity for that query: <code className="font-mono">recipeId={localId ?? "null"}</code>, <code className="font-mono">did={did}</code>,{" "}
                  <code className="font-mono">rkey={rkey}</code>.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {data.repo?.handle ? (
        <p className="text-xs text-muted-foreground">
          <a
            href={`https://bsky.app/profile/${encodeURIComponent(asText(data.repo.handle))}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-4"
          >
            @{asText(data.repo.handle)} on bsky.app
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** `recipe_ingredient` / `recipe_instruction` — same shape, same rendering. */
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
