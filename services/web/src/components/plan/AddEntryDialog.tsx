import { useEffect, useRef, useState } from "react";
import { BookOpenText, CalendarRange, UtensilsCrossed, X } from "lucide-react";
import { listHouseholdRecipes, type HouseholdRecipeRow } from "#/server/household-recipes";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { SLOT_LABELS, formatPlanDate, longDow } from "#/lib/plan/labels";
import { Button } from "#/components/ui/button";
import { CheckboxRow } from "#/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";

/**
 * The add dialog: one slot, two ways to fill it (§6.2/§6.3).
 *
 * "From your box" picks any number of recipes in one pass — a weeknight is
 * usually planned a slot at a time, not a recipe at a time, so the confirm
 * button counts what you picked and one submit writes them all in order. "Write
 * a note" covers everything a recipe cannot say ("leftovers", "Sam cooks").
 *
 * The same dialog EDITS a note (the popover's "Edit this note"). An edit is the
 * note tab with its text already in the box and no recipes tab: the two halves
 * of "what goes in this slot" are the same question, and a second dialog for a
 * three-line textarea would be a second place for the copy to drift.
 *
 * The box list is fetched lazily on first open and kept for the life of the
 * page. Putting it in the plan route's loader would make every week navigation
 * pay for a list most visits never open, and the box changes rarely enough that
 * a stale row is a cosmetic problem the next reload fixes.
 */

/** What the route is asking the dialog to do. Null ⇒ closed. */
export type AddEntryRequest =
  | { kind: "add"; date: PlanDate; slot: MealSlot; existingCount: number; isToday: boolean }
  | { kind: "edit-note"; date: PlanDate; slot: MealSlot; entryId: string; body: string };

interface AddEntryDialogProps {
  request: AddEntryRequest | null;
  onClose: () => void;
  /** Recipes in the order the box lists them — the order they land in the slot. */
  onSubmitRecipes: (rows: HouseholdRecipeRow[]) => void;
  /** Add or update, depending on the request the dialog was opened with. */
  onSubmitNote: (body: string) => void;
}

/**
 * The box lives out here because it outlives any one open, and the form lives
 * inside because none of its state should: closing unmounts the form, so the
 * next open starts from nothing without a single reset.
 */
export function AddEntryDialog({ request, onClose, onSubmitRecipes, onSubmitNote }: AddEntryDialogProps) {
  const [box, setBox] = useState<HouseholdRecipeRow[] | null>(null);
  const [boxFailed, setBoxFailed] = useState(false);
  // One fetch per page load, guarded against React's double-invoked effects.
  const boxRequested = useRef(false);

  useEffect(() => {
    if (!request || boxRequested.current) return;
    boxRequested.current = true;
    listHouseholdRecipes()
      .then(setBox)
      .catch(() => setBoxFailed(true));
  }, [request]);

  if (!request) return null;
  return <AddEntryForm request={request} box={box} boxFailed={boxFailed} onClose={onClose} onSubmitRecipes={onSubmitRecipes} onSubmitNote={onSubmitNote} />;
}

function AddEntryForm({
  request,
  box,
  boxFailed,
  onClose,
  onSubmitRecipes,
  onSubmitNote,
}: Omit<AddEntryDialogProps, "request"> & { request: AddEntryRequest; box: HouseholdRecipeRow[] | null; boxFailed: boolean }) {
  const editing = request.kind === "edit-note";
  const [tab, setTab] = useState<"recipes" | "note">(editing ? "note" : "recipes");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState(request.kind === "edit-note" ? request.body : "");

  const { date, slot } = request;
  const rows = box ?? [];
  const q = query.trim().toLowerCase();
  const matches = q ? rows.filter((row) => row.title.toLowerCase().includes(q)) : rows;
  const count = selected.length;
  const noteBody = note.trim();

  const title = editing ? "Edit this note" : `Add to ${longDow(date)} ${SLOT_LABELS[slot].toLowerCase()}`;
  const already = request.kind === "add" ? request.existingCount : 0;
  const description = editing
    ? `${SLOT_LABELS[slot]} · ${formatPlanDate(date)}`
    : `${formatPlanDate(date)}${request.isToday ? " · today" : ""} · ${already === 0 ? "nothing here yet" : already === 1 ? "1 entry already" : `${already} entries already`}`;
  const confirmLabel = tab === "note" ? "Save the note" : count > 0 ? `Add ${count} ${count === 1 ? "recipe" : "recipes"}` : "Add";

  function toggle(recipeId: string) {
    setSelected((prev) => (prev.includes(recipeId) ? prev.filter((id) => id !== recipeId) : prev.concat([recipeId])));
  }

  function confirm() {
    if (tab === "note") {
      // An emptied note is a removal, not a blank card — the server agrees
      // (§6.3), so an edit may legitimately submit "".
      if (!editing && noteBody === "") return onClose();
      onSubmitNote(noteBody);
      return onClose();
    }
    const picked = rows.filter((row) => selected.includes(row.recipeId));
    if (picked.length === 0) return onClose();
    onSubmitRecipes(picked);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <div className="flex items-start gap-[9px]">
          <span className="flex size-[34px] flex-none items-center justify-center rounded-lg border-2 border-border bg-secondary text-secondary-foreground shadow-pop-sm">
            <CalendarRange className="size-[17px]" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col gap-px">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </span>
        </div>

        {/* Editing a note is note-only: there is nothing to pick from the box. */}
        {!editing && (
          <div className="flex gap-1.5">
            {(["recipes", "note"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "h-7 rounded-lg border-2 border-border px-2.5 text-xs font-semibold focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  tab === value ? "bg-secondary text-secondary-foreground" : "bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {value === "recipes" ? "From your box" : "Write a note"}
              </button>
            ))}
          </div>
        )}

        {tab === "recipes" ? (
          <div className="flex flex-col gap-[7px]">
            <span className="flex h-8 items-center gap-[7px] rounded-lg border-2 border-border bg-background px-2.5 text-muted-foreground">
              <BookOpenText className="size-3.5 shrink-0" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search your box · ${rows.length} recipes`}
                aria-label="Search your recipe box"
                className="min-w-0 flex-1 border-0 bg-transparent text-[0.8125rem] font-medium text-foreground outline-none"
              />
              {query.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear the search"
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-[13px]" aria-hidden="true" />
                </button>
              )}
            </span>

            <div className="flex max-h-[14rem] flex-col gap-1 overflow-auto pr-0.5">
              {matches.map((row) => (
                <CheckboxRow
                  key={row.recipeId}
                  size="sm"
                  checked={selected.includes(row.recipeId)}
                  onCheckedChange={() => toggle(row.recipeId)}
                  meta={row.totalTimeDisplay ?? undefined}
                >
                  {row.title}
                </CheckboxRow>
              ))}
              {matches.length === 0 && (
                <div className="flex flex-col items-center gap-[5px] px-4 py-6 text-center text-muted-foreground">
                  <UtensilsCrossed className="size-[26px]" aria-hidden="true" />
                  {box === null && !boxFailed ? (
                    <p className="m-0 text-[0.8125rem] font-bold text-foreground">Fetching your box…</p>
                  ) : boxFailed ? (
                    <>
                      <p className="m-0 text-[0.8125rem] font-bold text-foreground">Your box didn’t load.</p>
                      <p className="m-0 text-xs">Reload the page, or write a note instead.</p>
                    </>
                  ) : (
                    <>
                      <p className="m-0 text-[0.8125rem] font-bold text-foreground">Nothing in your box matches that.</p>
                      <p className="m-0 text-xs">Clear the search, or add it to your box from Recipes first.</p>
                    </>
                  )}
                </div>
              )}
            </div>

            <span className="text-[0.6875rem] font-semibold text-muted-foreground">
              {count === 0 ? "Nothing picked yet" : `${count} ${count === 1 ? "recipe picked" : "recipes picked"}`}
            </span>
          </div>
        ) : (
          <Textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Leftovers · thaw the chicken · Sam cooks tonight"
            aria-label={editing ? "Note" : "Note for this slot"}
          />
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
