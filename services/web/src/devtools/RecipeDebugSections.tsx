import { useId, type ReactNode } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { CopyButton } from "./CopyButton";
import { JsonBlock } from "./JsonBlock";
import type { AtprotoRecordView, CounterpartView, DebugSection, RecipeDebugPayload } from "./types";

/**
 * The section renderers for the recipe inspector panel. Two shapes:
 *
 * - `RecipeDebugHeader`, `AtprotoRecordSection`, `CounterpartsSection` know
 *   their fields — the contract names them, so the UI does too.
 * - `DebugSectionGroup` / `DebugSectionCard` / `RowView` know NOTHING about
 *   any particular table (`types.ts`'s "SECTIONS ARE GENERIC ON PURPOSE").
 *   A new sidecar table needs a new server-side query and nothing here.
 */

function SectionHeading({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="m-0 text-[0.6875rem] font-bold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function FieldRow({ field, value }: { field: string; value: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-muted-foreground">{field}</dt>
      <dd className="m-0 font-mono break-words">{value}</dd>
    </>
  );
}

// --- header ------------------------------------------------------------

export function RecipeDebugHeader({ summary, action }: { summary: NonNullable<RecipeDebugPayload["summary"]>; action: ReactNode }) {
  return (
    <div className="flex-1 rounded-md border-2 border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h2 className="m-0 text-sm font-bold text-foreground">{summary.name}</h2>
        <div className="flex items-center gap-1.5">
          <Badge size="xs" variant="outline">
            {summary.origin}
          </Badge>
          <Badge size="xs" variant={summary.visibility === "public" ? "secondary" : "outline"}>
            {summary.visibility}
          </Badge>
          {action}
        </div>
      </div>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs">
        <FieldRow field="did" value={summary.did ?? "—"} />
        <FieldRow field="rkey" value={summary.rkey ?? "—"} />
        <FieldRow field="cid" value={summary.cid ?? "—"} />
        <FieldRow field="rev" value={summary.rev ?? "—"} />
        <FieldRow field="published at" value={summary.publishedAt ? new Date(summary.publishedAt).toLocaleString() : "—"} />
      </dl>
    </div>
  );
}

// --- (a) the atproto record ---------------------------------------------

function ValidationBadge({ status }: { status: string }) {
  const variant = status === "valid" ? "secondary" : status === "invalid" ? "destructive" : "outline";
  return (
    <Badge size="xs" variant={variant}>
      {status}
    </Badge>
  );
}

export function AtprotoRecordSection({ record }: { record: AtprotoRecordView | null }) {
  return (
    <SectionHeading title="Raw atproto record">
      {record === null ? (
        <p className="m-0 text-xs text-muted-foreground">Never published — no atproto record for this recipe.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs">
            <FieldRow field="uri" value={record.uri} />
            <FieldRow field="cid" value={record.cid} />
            <FieldRow field="rev" value={record.rev} />
            <FieldRow field="validation" value={<ValidationBadge status={record.validationStatus} />} />
            <FieldRow field="indexed at" value={record.indexedAt ? new Date(record.indexedAt).toLocaleString() : "—"} />
            {record.deletedAt && (
              <FieldRow field="deleted at" value={<span className="text-destructive">{new Date(record.deletedAt).toLocaleString()} — gone from its repo</span>} />
            )}
          </dl>
          {/* The headline feature: open by default, easy to read, easy to copy. */}
          <JsonBlock value={record.record} label="record" defaultOpen />
        </div>
      )}
    </SectionHeading>
  );
}

// --- (b) counterparts -----------------------------------------------------

export function CounterpartsSection({ counterparts }: { counterparts: CounterpartView[] }) {
  return (
    <SectionHeading title="Counterparts — same dish, another row">
      {counterparts.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">No other row in the index is the same dish.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {counterparts.map((counterpart) => (
            <li key={counterpart.recipeId}>
              <div className="flex flex-col gap-1 rounded-md border-2 border-border bg-card px-2 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-foreground">{counterpart.name}</span>
                  <Badge size="xs" variant="outline">
                    {counterpart.origin}
                  </Badge>
                  <Badge size="xs" variant="outline">
                    {counterpart.visibility}
                  </Badge>
                  {counterpart.inBox && (
                    <Badge size="xs" variant="secondary">
                      in your box
                    </Badge>
                  )}
                </div>
                {/* content_fp and source_url_key mean different things: identical
                    ingredients vs. the same source page (types.ts) — say so, not
                    just the key name. */}
                <p className="m-0 text-muted-foreground">
                  Matched on <span className="font-semibold text-foreground">{counterpart.matchedOn === "content_fp" ? "content" : "source URL"}</span> —{" "}
                  {counterpart.matchedOn === "content_fp" ? "identical ingredients, not necessarily the same source page." : "same source page; ingredients may differ."}
                </p>
                <p className="m-0 font-mono text-muted-foreground">{counterpart.did ?? "no did"}</p>
                <p className="m-0 font-mono text-muted-foreground">{counterpart.recipeId}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionHeading>
  );
}

// --- (c) generic table sections -------------------------------------------

function RowView({ row }: { row: unknown }) {
  if (row !== null && typeof row === "object" && !Array.isArray(row)) {
    const entries = Object.entries(row as Record<string, unknown>);
    return (
      <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 rounded border border-border/50 bg-muted px-2 py-1.5 text-[0.6875rem]">
        {entries.map(([field, value]) => (
          <FieldRow key={field} field={field} value={formatValue(value)} />
        ))}
      </dl>
    );
  }
  return <pre className="m-0 rounded border border-border/50 bg-muted px-2 py-1.5 font-mono text-[0.6875rem] whitespace-pre-wrap">{JSON.stringify(row, null, 2)}</pre>;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    // Same circular-reference / BigInt case as JsonBlock's `stringify` —
    // `String(value)` on an unserializable object would just say
    // "[object Object]", which tells a reader nothing.
    return "<could not serialize this value as JSON>";
  }
}

function DebugSectionCard({ section }: { section: DebugSection }) {
  return (
    <div className="relative rounded-md border-2 border-border bg-card">
      <details className="group/section">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 py-1.5 pr-24 pl-2 text-xs font-semibold text-foreground select-none [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-1.5">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/section:rotate-90" aria-hidden="true" />
            {section.table}
          </span>
          <Badge size="xs" variant="outline">
            {section.rows.length} row{section.rows.length === 1 ? "" : "s"}
          </Badge>
          {/* Anything from privateLayers must be visibly marked as never-published
              (AGENTS.md instructions for this panel). */}
          {!section.published && (
            <Badge size="xs" variant="outline" className="border-warning text-warning bg-warning/15">
              never published
            </Badge>
          )}
        </summary>
        <div className="flex flex-col gap-2 border-t-2 border-border/60 px-2 py-1.5">
          {/* The note is part of the contract, not decoration — render it, don't
              drop it (e.g. enrichment's "not_detected ≠ free of" caveat). */}
          <p className="m-0 text-[0.6875rem] text-muted-foreground italic">{section.note}</p>
          {section.rows.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">No rows.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {section.rows.map((row, i) => (
                <li key={i}>
                  <RowView row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
      <div className="absolute top-1 right-1.5">
        <CopyButton value={section.rows} label={`${section.table} rows`} />
      </div>
    </div>
  );
}

export function DebugSectionGroup({ title, sections }: { title: string; sections: DebugSection[] }) {
  return (
    <SectionHeading title={title}>
      {sections.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">Nothing recorded.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sections.map((section) => (
            <DebugSectionCard key={section.table} section={section} />
          ))}
        </div>
      )}
    </SectionHeading>
  );
}

// --- warnings ---------------------------------------------------------------

export function WarningsSection({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Don't trust these sections at face value</AlertTitle>
      <AlertDescription>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
