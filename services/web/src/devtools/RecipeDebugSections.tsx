import { useId, type ReactNode } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { CopyButton } from "./CopyButton";
import { JsonBlock } from "./JsonBlock";
import { LlmEnrichButton } from "./LlmEnrichButton";
import type { AtprotoRecordView, CounterpartView, DebugSection, LlmEnrichmentSummary, LlmHighlightLabel, RecipeDebugPayload } from "./types";

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

// --- (d) the LLM enrichment highlight --------------------------------------
//
// The one deliberate exception to "SECTIONS ARE GENERIC ON PURPOSE"
// (devtools/types.ts) — everything it shows is also visible, raw and
// unedited, in the generic `recipe_enrichment` / `recipe_enrichment_label`
// cards below (privateLayers); this block exists to answer the questions
// those raw rows make a reader do arithmetic for (types.ts's
// `LlmEnrichmentSummary` doc has the field-by-field reasoning).

function LlmStatusBadge({ status }: { status: string | null }) {
  if (status === "ok")
    return (
      <Badge size="xs" variant="secondary">
        ok
      </Badge>
    );
  if (status === "error")
    return (
      <Badge size="xs" variant="destructive">
        error
      </Badge>
    );
  if (status === "skipped")
    return (
      <Badge size="xs" variant="outline" className="border-warning text-warning bg-warning/15">
        skipped
      </Badge>
    );
  return (
    <Badge size="xs" variant="outline">
      never run
    </Badge>
  );
}

/**
 * `source` is the visual distinction the LLM highlight exists to draw — a
 * filled badge for the model's own rows, an outline one for the rules', with
 * the full `method` string (e.g. `llm:openrouter:mistralai/mistral-small-24b-instruct-2501@v1`) in
 * the title attribute for whoever wants the exact provenance without leaving
 * this row.
 */
function LabelSourceBadge({ source, method }: { source: "rules" | "llm"; method: string }) {
  return (
    <Badge size="xs" variant={source === "llm" ? "default" : "outline"} title={method}>
      {source}
    </Badge>
  );
}

function LlmLabelRow({ label }: { label: LlmHighlightLabel }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded border border-border/50 bg-muted px-2 py-1 text-[0.6875rem]">
      <LabelSourceBadge source={label.source} method={label.method} />
      <span className="font-mono font-semibold text-foreground">{label.slug}</span>
      <span className="text-muted-foreground">{label.verdict}</span>
      <span className="text-muted-foreground">· {Math.round(label.confidence * 100)}%</span>
    </li>
  );
}

export function LlmEnrichmentSection({ recipeId, summary }: { recipeId: string; summary: LlmEnrichmentSummary | null }) {
  const dimensions = summary ? Object.entries(summary.labelsByDimension).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <SectionHeading title="LLM enrichment">
      <div className="flex flex-col gap-2 rounded-md border-2 border-border bg-card px-3 py-2.5">
        {summary === null ? (
          <p className="m-0 text-xs text-muted-foreground">
            No <code className="font-mono">recipe_enrichment</code> row at all yet — nothing, rules or LLM, has classified this recipe. Triggering LLM enrichment will still queue
            the job below, but it needs a rules pass first and will come back <code className="font-mono">skipped</code> until one exists.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <LlmStatusBadge status={summary.status} />
              {summary.freshAgainstRules ? (
                <Badge size="xs" variant="secondary">
                  fresh vs rules
                </Badge>
              ) : (
                <Badge size="xs" variant="outline">
                  stale vs rules
                </Badge>
              )}
              {!summary.rulesVersionCurrent && (
                <Badge size="xs" variant="outline" className="border-warning text-warning bg-warning/15">
                  rules pass not current — a run will likely come back skipped
                </Badge>
              )}
            </div>

            {summary.error && (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>llm-enrich failed</AlertTitle>
                <AlertDescription>{summary.error}</AlertDescription>
              </Alert>
            )}

            <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs">
              <FieldRow field="model" value={summary.model ?? "—"} />
              <FieldRow
                field="prompt"
                value={
                  summary.promptVersion !== null
                    ? `v${summary.promptVersion} (PostHog)`
                    : summary.status === "ok"
                      ? "fallback prompt — the committed prompt.ts ran, not an unknown version"
                      : "—"
                }
              />
              <FieldRow field="enriched at" value={summary.enrichedAt ? new Date(summary.enrichedAt).toLocaleString() : "—"} />
              <FieldRow field="llm_version" value={summary.llmVersion === 0 ? "0 (never run)" : String(summary.llmVersion)} />
              <FieldRow
                field="classifier_version"
                value={`${summary.classifierVersion}${summary.rulesVersionCurrent ? " (current)" : " (stale — a newer rules classifier is deployed)"}`}
              />
              <FieldRow field="rules status" value={summary.rulesStatus} />
              <FieldRow field="input_hash" value={summary.inputHash ?? "—"} />
              <FieldRow field="llm_input_hash" value={summary.llmInputHash ?? "—"} />
            </dl>

            {dimensions.length > 0 && (
              <div className="flex flex-col gap-2">
                {dimensions.map(([dimension, labels]) => (
                  <div key={dimension} className="flex flex-col gap-1">
                    <h4 className="m-0 text-[0.6875rem] font-semibold text-foreground">{dimension}</h4>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {labels.map((label) => (
                        <LlmLabelRow key={`${label.dimension}:${label.slug}`} label={label} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {/* not_detected is never a safety claim, and absence is never a
                negative verdict on its own — repeated here, in the LLM's own
                words, because this block is exactly where a reader would
                otherwise read "no cuisine label" as "the model checked and
                found none" when it may just mean "never asked". */}
            <p className="m-0 text-[0.6875rem] text-muted-foreground italic">
              A missing slug above is never a negative verdict by itself. For allergen, and for the diet slugs the rules classifier also emits, absence means the rules' own default
              (not_detected / not excluded) once classifier_version is current — see the recipe_enrichment_label card below for the exact wording, and note that{" "}
              <span className="font-semibold text-foreground">not_detected is never a safety claim</span>, only "nothing matched in text the classifier may not have fully parsed".
              For dimensions only the LLM ever judges (cuisine, meal_type, spice_level, and several diet slugs the rules have no rule for), absence means NOTHING was evaluated
              unless status above is "ok" and llm_version covered it — this panel cannot tell "the model looked and found nothing" apart from "this was never asked" from the row
              set alone.
            </p>
          </>
        )}
        <LlmEnrichButton recipeId={recipeId} />
      </div>
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
