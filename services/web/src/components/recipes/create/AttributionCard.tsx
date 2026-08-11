import { ExternalLink, Lock, Pencil } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Input } from "#/components/ui/input";
import { Select } from "#/components/ui/select";
import { Button } from "#/components/ui/button";
import { ATTRIBUTION_FIELDS, ATTRIBUTION_TYPES, LICENSE_OPTIONS, type AttributionState, type AttributionType, attributionComplete } from "#/lib/recipe-attribution";

/**
 * Attribution rail card (plan §A5). Manual: a source-type select that reveals the
 * chosen union's required fields (Original reveals a license). Import: the Website
 * attribution is LOCKED read-only to the source URL, with a "Start over by hand"
 * escape hatch that drops the lock. Saving is gated on this being complete.
 */
export function AttributionCard({
  state,
  onChange,
  locked,
  onStartOver,
}: {
  state: AttributionState;
  onChange: (s: AttributionState) => void;
  /** When set, the card is locked to this imported Website source. */
  locked?: { name: string; url: string } | null;
  onStartOver?: () => void;
}) {
  if (locked) return <LockedCard locked={locked} onStartOver={onStartOver} />;

  const type = state.type;
  const complete = attributionComplete(state);
  const fields = type ? ATTRIBUTION_FIELDS[type] : [];

  return (
    <div id="attribution-block" className="overflow-hidden rounded-xl border-2 border-destructive bg-card shadow-(--shadow-pop-md)">
      <div className="flex items-center gap-2 border-b-2 border-destructive bg-[color-mix(in_oklab,var(--destructive)_10%,var(--card))] px-3.5 py-2.5">
        <Pencil className="size-4 text-destructive" aria-hidden="true" />
        <span className="text-sm font-bold text-destructive">Attribution</span>
        <Badge variant="destructive" size="xs" className="ml-auto">
          Required
        </Badge>
      </div>
      <div className="flex flex-col gap-3 p-3.5">
        <p className="m-0 text-sm text-muted-foreground text-pretty">
          Someone wrote this recipe and deserves the credit — and a public atproto record outlives this app. Yours? Pick <strong className="text-foreground">Original</strong>.
        </p>
        <div className="flex flex-col gap-2">
          <label htmlFor="f-attr" className="bt-label">
            Where did this come from?
          </label>
          <Select id="f-attr" value={type} onChange={(e) => onChange({ type: e.target.value as AttributionType | "", values: {}, license: "" })}>
            <option value="">Choose a source…</option>
            {ATTRIBUTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>

        {type && (
          <div className="flex flex-col gap-3 border-t-2 border-border/60 pt-3">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-2">
                <label className="bt-label">
                  {f.label}
                  {f.required && <span className="font-bold text-destructive"> *</span>}
                </label>
                <Input
                  placeholder={f.placeholder}
                  value={state.values[f.key] ?? ""}
                  onChange={(e) => onChange({ ...state, values: { ...state.values, [f.key]: e.target.value } })}
                />
              </div>
            ))}
            {type === "original" && (
              <div className="flex flex-col gap-2">
                <label className="bt-label">
                  License<span className="font-bold text-destructive"> *</span>
                </label>
                <Select value={state.license} onChange={(e) => onChange({ ...state, license: e.target.value })}>
                  <option value="">Choose a license…</option>
                  {LICENSE_OPTIONS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
                <p className="bt-field-description m-0">Travels with the record when anyone else's app reads it.</p>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold text-muted-foreground">
              {complete ? "Complete" : type ? "Fill the starred fields" : "Nothing chosen yet"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LockedCard({ locked, onStartOver }: { locked: { name: string; url: string }; onStartOver?: () => void }) {
  return (
    <div className="overflow-hidden rounded-xl border-2 border-border bg-card shadow-(--shadow-pop-md)">
      <div className="flex items-center gap-2 border-b-2 border-border bg-secondary px-3.5 py-2.5 text-secondary-foreground">
        <Lock className="size-4" aria-hidden="true" />
        <span className="text-sm font-bold">Attribution</span>
        <Badge variant="outline" size="xs" className="ml-auto">
          <Lock className="size-3" aria-hidden="true" />
          Locked
        </Badge>
      </div>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-col gap-1">
          <span className="text-[0.6875rem] font-semibold tracking-wide uppercase text-muted-foreground">Website</span>
          <span className="text-base font-semibold text-foreground">{locked.name}</span>
          <a href={locked.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm break-all">
            {locked.url}
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        </div>
        <p className="m-0 text-sm text-muted-foreground text-pretty">
          An imported recipe is credited to the page it came from, and that isn't editable — the source stays with the record.
        </p>
        {onStartOver && (
          <Button variant="ghost" size="sm" className="self-start" onClick={onStartOver}>
            Start over by hand
          </Button>
        )}
      </div>
    </div>
  );
}
