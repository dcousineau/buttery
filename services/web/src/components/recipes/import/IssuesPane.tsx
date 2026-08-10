import { useLayoutEffect, useRef, useState } from "react";
import type { ImportItem } from "#/lib/recipe-import/machine.ts";
import { recipeRecordProblems, type RecipeRecordInput, type RecordProblem } from "#/lib/recipe-record";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { IngredientsEditor } from "#/components/recipes/create/IngredientsEditor";
import { InstructionsEditor } from "#/components/recipes/create/InstructionsEditor";
import { RecipeSlat, RecipeSlatAction, RecipeSlatAside, RecipeSlatBody, RecipeSlatDetail, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "#/components/recipes/RecipeSlat";
import { recipeCount } from "./groups.ts";

/**
 * "Needs a fix" — the recipes the lexicon would refuse, put in front of the user *before*
 * the import instead of after it.
 *
 * These used to surface on the done screen, as ten lines of "instructions.0: string too big
 * (maximum 1000, got 1120)" under "didn't make it", with the editor gone and nothing to do
 * about it. Everything on this screen follows from that being the wrong moment:
 *
 * - The rule is not restated. `recipeRecordProblems` runs the *same* schema
 *   `persistRecipeDraft` gates on, so a card here is a real prediction of the rejection and
 *   cannot drift from it.
 * - The failure is named in the user's terms ("This step is 1,120 characters; the limit is
 *   1,000"), because a wire path and a Zod code are not a thing anyone can act on.
 * - Picking a card puts the cursor **in the offending row**, expanded and scrolled to. The
 *   editor arrives in Rows mode for exactly this reason: Paste mode is a disclosure that
 *   hides which of 14 steps is the long one.
 * - The editor gets the wide column here, unlike every other group's preview: this is the
 *   one place in the rail where the work is typing rather than choosing.
 *
 * Nothing here blocks the import. A user who does not want to rewrite a step can walk past
 * this group and let those few land in "didn't make it" exactly as before.
 */
export function IssuesPane({
  items,
  onPatch,
  onSkip,
  footer,
}: {
  items: ImportItem[];
  onPatch: (clientId: string, patch: Partial<RecipeRecordInput>) => void;
  onSkip: (clientId: string) => void;
  footer: React.ReactNode;
}) {
  const entries = items.flatMap((item) => recipeRecordProblems(item.record).map((problem) => ({ item, problem })));

  // Selection is held as (recipe, field) and *resolved* against the live list rather than
  // stored as an index: cards vanish as they are fixed, and an index would silently slide
  // onto whatever moved up. Fixing one problem keeps the user on the same recipe if it has
  // another; only when a recipe is clean does the pane move on.
  const [selection, setSelection] = useState<{ clientId: string; path: string } | null>(null);
  const active =
    entries.find((entry) => entry.item.clientId === selection?.clientId && entry.problem.path === selection.path) ??
    entries.find((entry) => entry.item.clientId === selection?.clientId) ??
    entries[0] ??
    null;

  // Focus moves only when the user asks for it (a card click), never as a side effect of the
  // list changing — pulling the cursor out of a textarea mid-sentence, because the sentence
  // just got short enough to be legal, is the opposite of helping. A ref rather than state
  // because the request is a one-shot instruction to the DOM, not something to re-render for;
  // it is consumed in a layout effect because the row it names may only exist after the click
  // has swapped the editor to a different recipe.
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus();
  });

  const affected = new Set(entries.map((entry) => entry.item.clientId)).size;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none border-b-2 border-border px-5 py-3.5">
        <h2 className="display-title m-0 text-xl/[1.15]">A few won't save as they are</h2>
        <p className="m-0 mt-1 max-w-[52rem] text-[0.8125rem] text-muted-foreground">
          {entries.length === 0
            ? "Nothing to fix — every recipe you're importing fits."
            : `${recipeCount(affected)} ${affected === 1 ? "has" : "have"} a field that's too long to store. Pick one to jump straight to it. You can leave them — they'll be listed as “didn't make it” at the end instead.`}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Slats, not cards (`RecipeSlat`). This column is a list of recipes to work through,
            exactly like the box and the review list, and it was the odd one out: gapped rounded
            cards with a `pop-md` shadow on the current one. Same bar, same butter marker, and
            the container queries do the rest — this column is 320px, so it lands a tier below
            the import review pane without either of them knowing the viewport's width. */}
        <RecipeSlatList className="w-80 flex-none overflow-auto border-r-2 border-border">
          {entries.map((entry) => {
            const key = `${entry.item.clientId}#${entry.problem.path}`;
            const current = active?.item.clientId === entry.item.clientId && active.problem.path === entry.problem.path;
            return (
              <RecipeSlat key={key} selected={current}>
                <RecipeSlatAction
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    setSelection({ clientId: entry.item.clientId, path: entry.problem.path });
                    pendingFocus.current = fieldDomId(entry.item.clientId, entry.problem);
                  }}
                  className="cursor-(--cursor-interactive) items-start"
                >
                  <RecipeSlatBody>
                    <RecipeSlatTitle>
                      <span className="truncate">{entry.item.record.name || entry.item.entryName}</span>
                    </RecipeSlatTitle>
                    {/* The message is a sentence, not a label: it wraps rather than truncating,
                        because "This step is 1,120 characters; the limit is…" is the whole point
                        of the row. */}
                    <RecipeSlatMeta wrap>{entry.problem.message}</RecipeSlatMeta>
                    {/* A problem in a field this editor has no control for (a cuisine token, say)
                        still gets a row — being told what is wrong beats being told nothing —
                        but it must not pretend clicking will take you somewhere. */}
                    {entry.problem.editable ? null : <RecipeSlatDetail wrap>Not editable here — this one will be reported at the end.</RecipeSlatDetail>}
                  </RecipeSlatBody>
                  <RecipeSlatAside>
                    <Badge variant="outline" size="xs">
                      {entry.problem.label}
                    </Badge>
                  </RecipeSlatAside>
                </RecipeSlatAction>
              </RecipeSlat>
            );
          })}

          {entries.length === 0 ? <li className="px-2.5 py-4 text-sm text-muted-foreground">Nothing to fix.</li> : null}
        </RecipeSlatList>

        {active ? (
          <IssueEditor
            // Remounting per recipe is what puts both line editors back in Rows mode when the
            // user lands on a new card — the disclosure must never start closed over an error.
            key={active.item.clientId}
            item={active.item}
            problems={recipeRecordProblems(active.item.record)}
            onPatch={(patch) => onPatch(active.item.clientId, patch)}
            onSkip={() => onSkip(active.item.clientId)}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center px-5 text-sm text-muted-foreground">Nothing here needs a fix.</div>
        )}
      </div>

      <div className="flex flex-none items-center gap-3 border-t-2 border-border bg-card px-5 py-2.5">
        <div className="text-[0.8125rem] text-muted-foreground">
          {entries.length === 0 ? "All clear" : `${entries.length} ${entries.length === 1 ? "field" : "fields"} to fix across ${recipeCount(affected)}`}
        </div>
        <div className="ml-auto" />
        {footer}
      </div>
    </div>
  );
}

/** The element a card sends the cursor to, or null when the editor has no control for it. */
function fieldDomId(clientId: string, problem: RecordProblem): string | null {
  if (!problem.editable) return null;
  return problem.index === null ? `issue-${clientId}-${problem.field}` : `issue-${clientId}-${problem.field}-${problem.index}`;
}

function IssueEditor({
  item,
  problems,
  onPatch,
  onSkip,
}: {
  item: ImportItem;
  problems: RecordProblem[];
  onPatch: (patch: Partial<RecipeRecordInput>) => void;
  onSkip: () => void;
}) {
  const [ingMode, setIngMode] = useState<"paste" | "rows">("rows");
  const [stepMode, setStepMode] = useState<"paste" | "rows">("rows");

  const rowProblem = (field: string) => (index: number) => problems.find((problem) => problem.field === field && problem.index === index)?.message ?? null;
  const fieldProblem = (field: string) => problems.find((problem) => problem.field === field && problem.index === null)?.message ?? null;
  const nameProblem = fieldProblem("name");
  const textProblem = fieldProblem("text");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-auto px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="text-[0.8125rem] text-muted-foreground">{item.sourceUrl ?? item.sourceText ?? item.entryName}</div>
        <div className="ml-auto" />
        <Button variant="outline" size="sm" onClick={onSkip}>
          Leave this one out
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`issue-${item.clientId}-name`} className="text-xs font-semibold text-muted-foreground">
          Recipe name
        </label>
        <Input
          id={`issue-${item.clientId}-name`}
          size="lg"
          className="font-semibold"
          value={item.record.name}
          aria-invalid={nameProblem ? true : undefined}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
        {nameProblem ? <p className="m-0 text-[0.6875rem] font-medium text-destructive">{nameProblem}</p> : null}
      </div>

      {/* The description is here and nowhere else in the import flow. It is the second most
          common thing to be too long (a whole blog post pasted into one field), and there is
          no point sending someone to a field they cannot see. */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`issue-${item.clientId}-text`} className="text-xs font-semibold text-muted-foreground">
          Description
        </label>
        <Textarea
          id={`issue-${item.clientId}-text`}
          rows={4}
          value={item.record.text}
          aria-invalid={textProblem ? true : undefined}
          onChange={(event) => onPatch({ text: event.target.value })}
        />
        {textProblem ? <p className="m-0 text-[0.6875rem] font-medium text-destructive">{textProblem}</p> : null}
      </div>

      <div>
        <h3 className="m-0 mb-1.5 text-[0.9375rem] font-semibold">Ingredients · {item.record.ingredients.length}</h3>
        <IngredientsEditor
          lines={item.record.ingredients}
          onChange={(lines) => onPatch({ ingredients: lines })}
          mode={ingMode}
          onModeChange={setIngMode}
          rowId={(index) => `issue-${item.clientId}-ingredients-${index}`}
          rowProblem={rowProblem("ingredients")}
        />
      </div>

      <div>
        <h3 className="m-0 mb-1.5 text-[0.9375rem] font-semibold">Steps · {item.record.instructions.length}</h3>
        <InstructionsEditor
          lines={item.record.instructions}
          onChange={(lines) => onPatch({ instructions: lines })}
          mode={stepMode}
          onModeChange={setStepMode}
          rowId={(index) => `issue-${item.clientId}-instructions-${index}`}
          rowProblem={rowProblem("instructions")}
        />
      </div>
    </div>
  );
}
