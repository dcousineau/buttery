import { useId } from "react";
import { type AttributionKind, type GroupChoice, isGroupAnswered } from "#/lib/recipe-import/machine.ts";
import { NO_SOURCE_GROUP_KEY, type SourceGroup } from "#/lib/recipe-import/source-groups.ts";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils.ts";
import { recipeCount } from "./groups.ts";

/**
 * "Where did these come from?" — bulk attribution over source strings (plan §8, §10.1).
 *
 * The whole point is that the unit of work is a **string**, not a recipe: 81 recipes with no
 * link collapse into 28 answers, and answering one sets every recipe under it. Nothing here
 * merges two strings or guesses an author — §8.2 is explicit that the tool never invents
 * attribution, so a near-identical spelling gets a *hint* pointing at the group above and
 * still has to be answered on its own.
 *
 * Each card is a `<fieldset>` whose `<legend>` is the verbatim source string, so a screen
 * reader reads "Ottolenghi Simple pg 174 — Cookbook, radio button 1 of 4" rather than four
 * unlabelled chips in a row.
 */

const KIND_LABELS: { kind: AttributionKind; label: string }[] = [
  { kind: "publication", label: "Cookbook" },
  { kind: "person", label: "A person" },
  { kind: "website", label: "A website" },
  { kind: "skip", label: "Skip these" },
];

/** Chip-shaped radio. A real `<input type="radio">` under the paint: arrow keys, roving focus, and a name that groups it — all free. */
function KindChip({ name, kind, checked, onSelect, children }: { name: string; kind: AttributionKind; checked: boolean; onSelect: (k: AttributionKind) => void; children: string }) {
  return (
    <label className="cursor-(--cursor-interactive)">
      <input type="radio" name={name} value={kind} checked={checked} onChange={() => onSelect(kind)} className="peer sr-only" />
      <span
        className={cn(
          "inline-flex rounded-[0.6rem] border-2 border-border px-2.5 py-1 text-[0.8125rem] font-semibold transition-all",
          "peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
          checked ? "bg-secondary text-secondary-foreground shadow-pop-sm" : "bg-background text-foreground hover:bg-accent",
        )}
      >
        {children}
      </span>
    </label>
  );
}

function GroupFields({ choice, groupKey, idBase, onField }: { choice: GroupChoice; groupKey: string; idBase: string; onField: (field: Exclude<keyof GroupChoice, "kind">, value: string) => void }) {
  if (choice.kind === null || choice.kind === "skip") return null;

  const fields =
    choice.kind === "publication"
      ? ([
          { key: "publicationTitle" as const, label: "Book title", value: choice.publicationTitle, required: true },
          // Both are lexicon-required for a publication and neither can be derived from the
          // other, so the author is asked for rather than inferred (§8.2).
          { key: "publicationAuthor" as const, label: "Author — required", value: choice.publicationAuthor, required: true },
        ])
      : choice.kind === "person"
        ? ([{ key: "personName" as const, label: "Name", value: choice.personName, required: true }])
        : ([
            { key: "websiteName" as const, label: "Site name", value: choice.websiteName, required: false },
            { key: "websiteUrl" as const, label: "Link — required", value: choice.websiteUrl, required: true },
          ]);

  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {fields.map((field) => {
        const id = `${idBase}-${field.key}`;
        return (
          <span key={field.key} className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
              {field.label}
            </label>
            <input
              id={id}
              name={`${groupKey}-${field.key}`}
              value={field.value}
              required={field.required}
              onChange={(event) => onField(field.key, event.target.value)}
              className="h-8 w-full rounded-lg border-2 border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </span>
        );
      })}
    </div>
  );
}

export function SourcesPane({
  groups,
  choices,
  onKind,
  onField,
  footer,
}: {
  groups: SourceGroup[];
  choices: Record<string, GroupChoice>;
  onKind: (groupKey: string, kind: AttributionKind) => void;
  onField: (groupKey: string, field: Exclude<keyof GroupChoice, "kind">, value: string) => void;
  footer: React.ReactNode;
}) {
  const idBase = useId();
  const answered = groups.filter((group) => isGroupAnswered(choices[group.key])).length;
  const covered = groups.reduce((n, group) => n + group.clientIds.length, 0);
  // Answered is not the same as kept: a skipped group is answered and its recipes are gone.
  const kept = groups.reduce((n, group) => (choices[group.key]?.kind && choices[group.key]?.kind !== "skip" ? n + group.clientIds.length : n), 0);
  const byKey = new Map(groups.map((group) => [group.key, group]));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none border-b-2 border-border px-5 py-3.5">
        <h2 className="display-title m-0 text-xl/[1.15]">Where did these come from?</h2>
        <p className="m-0 mt-1 max-w-[52rem] text-[0.8125rem] text-muted-foreground">
          {recipeCount(covered)} name a cookbook or a person instead of a link, in {groups.length} distinct {groups.length === 1 ? "spelling" : "spellings"}. Answer once
          per name and every recipe under it is set — Buttery never invents an author for you.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
        {groups.map((group) => {
          const choice = choices[group.key];
          if (!choice) return null;
          const done = isGroupAnswered(choice);
          const similar = group.similarTo ? byKey.get(group.similarTo) : null;
          const noSource = group.key === NO_SOURCE_GROUP_KEY;

          return (
            <fieldset
              key={group.key}
              className={cn("m-0 rounded-2xl border-2 border-border bg-card px-4 py-3.5", done ? "opacity-75" : "shadow-pop-md")}
            >
              <legend className="flex w-full flex-wrap items-center gap-2.5 px-1">
                <span className="text-base font-semibold">{group.sourceText ?? "No source at all"}</span>
                <Badge variant="outline" size="xs">
                  {recipeCount(group.clientIds.length)}
                </Badge>
                {done ? (
                  <Badge variant="secondary" size="xs">
                    answered
                  </Badge>
                ) : null}
              </legend>

              {/* Hints, never answers. The page-reference split prefills a title and says so;
                  the misspelling hint points at a group ABOVE and merges nothing (§10.2). */}
              {noSource ? (
                <p className="m-0 mt-1 text-[0.8125rem] text-muted-foreground">
                  These name neither a link nor a source. Give them one to bring them in — “Skip these” leaves them behind, because a recipe with no attribution can't be saved.
                </p>
              ) : null}
              {group.pageReference ? (
                <p className="m-0 mt-1 text-xs text-muted-foreground">
                  Page reference “{group.pageReference}” is kept on the recipes either way — only the title is prefilled above.
                </p>
              ) : null}
              {similar ? <p className="m-0 mt-1 text-xs text-muted-foreground">Looks like a spelling of “{similar.sourceText}” above. Answer it however you like — nothing is merged.</p> : null}

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {KIND_LABELS.map((entry) => (
                  <KindChip key={entry.kind} name={`${idBase}-${group.key}`} kind={entry.kind} checked={choice.kind === entry.kind} onSelect={(kind) => onKind(group.key, kind)}>
                    {entry.label}
                  </KindChip>
                ))}
              </div>

              {/* "Skip these" is the one chip that decides the recipes' fate rather than their
                  attribution, and the difference is invisible on a 44-recipe group unless it
                  is said out loud (§8.1). */}
              {choice.kind === "skip" ? (
                <p className="m-0 mt-2 text-[0.8125rem] text-muted-foreground">
                  {recipeCount(group.clientIds.length)} left behind — a recipe with no attribution can't be saved.
                </p>
              ) : null}

              <GroupFields choice={choice} groupKey={group.key} idBase={`${idBase}-${group.key}`} onField={(field, value) => onField(group.key, field, value)} />
            </fieldset>
          );
        })}

        {groups.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Every recipe came in with a link, so there is nothing to sort here.</p> : null}
      </div>

      <div className="flex flex-none items-center gap-3 border-t-2 border-border bg-card px-5 py-2.5">
        <div className="text-[0.8125rem] text-muted-foreground">
          {answered === groups.length && groups.length > 0
            ? `All ${groups.length} names answered — ${recipeCount(kept)} attributed${covered - kept > 0 ? `, ${covered - kept} left behind` : ""}`
            : `${answered} of ${groups.length} names answered`}
        </div>
        <div className="ml-auto" />
        {footer}
      </div>
    </div>
  );
}
