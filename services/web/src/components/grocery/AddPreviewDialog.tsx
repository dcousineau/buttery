import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { cva } from "class-variance-authority";
import { Check, Pencil, UtensilsCrossed } from "lucide-react";
import { type GroceryPreview, type GroceryPreviewRow, commitGroceryAdd, previewGroceryAdd } from "#/server/grocery";
import { AISLE_LABELS, aisleOrder } from "#/lib/grocery/aisles";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { selectableRowVariants } from "#/components/ui/selectable-row";
import { Spinner } from "#/components/ui/spinner";
import { cn } from "#/lib/utils";
import { baseQuantity, editableQuantity, editableUnitLabel, renderRowQuantity } from "./optimistic";

/**
 * The confirm-preview before anything lands on the list (plan D9).
 *
 * Every recipe-derived add goes through here, and the reason is that the parse is
 * a guess. `recipe_ingredient` is free text, so "1 (14.5 oz) can diced tomatoes,
 * drained" has to be read rather than looked up, and the honest place to show
 * the reading is before it is written — not as a correction afterwards on a list
 * someone is already shopping.
 *
 * Three things the dialog says that the commit alone could not:
 *
 * - **Staples arrive unchecked** (D9). Salt, pepper and oil are in every recipe
 *   and in every kitchen; defaulting them on would make the list mostly noise,
 *   and defaulting them *invisible* would hide the one time you actually are out.
 * - **A row that will merge says so.** `mergesInto` is the server telling you
 *   this add joins a row you already have, which is the difference between "add
 *   1 lb" and "you'll end up with 1 lb 8 oz".
 * - **Quantity and name are editable, aisle is not.** D8 gives no per-row aisle
 *   override; the flat-list toggle on the route is the escape hatch.
 *
 * The preview is fetched lazily on open and **writes nothing** — closing the
 * dialog leaves the list exactly as it was.
 */

/** What the caller is asking to preview. Null ⇒ closed. */
export interface AddPreviewRequest {
  /** Explicit recipes, each with an optional scale (plan D4; default 1×). */
  recipes?: Array<{ recipeId: string; scale?: number }>;
  /** A week start (`YYYY-MM-DD`); the server snaps it to the household's week. */
  planWeek?: string;
  /** What to call the source in the dialog's copy — "this week's plan", a title. */
  label?: string;
}

export interface AddPreviewDialogProps {
  request: AddPreviewRequest | null;
  onClose: () => void;
  /** Fired after the commit lands. The route invalidates + toasts. */
  onCommitted: (result: { added: number; merged: number }) => void;
  onError: (message: string) => void;
}

/**
 * One candidate row, built the same way `GroceryRow` builds a real one: a flush
 * bar with the ledger's `border-b-2 border-border/45` divider, no radius and no
 * shadow. The preview is a picture of the list it is about to become, so it had
 * better be shaped like it — and the sticker construction it used to wear said
 * "press me" about a row whose only control is the checkbox inside it.
 */
const previewSlatVariants = cva("flex items-stretch border-b-2 border-border/45");

/** A stable identity for one request, so a second open always refetches. */
function requestKey(request: AddPreviewRequest): string {
  return [request.planWeek ?? "", ...(request.recipes ?? []).map((entry) => `${entry.recipeId}@${entry.scale ?? 1}`)].join("|");
}

/** The user's inline overrides for one row. `quantity` is in BASE units. */
interface RowEdit {
  displayName?: string;
  quantity?: number | null;
}

export function AddPreviewDialog({ request, onClose, onCommitted, onError }: AddPreviewDialogProps) {
  if (!request) return null;
  // Keyed so a fresh request starts from a fresh fetch and a fresh selection,
  // with no reset logic to forget.
  return <AddPreviewBody key={requestKey(request)} request={request} onClose={onClose} onCommitted={onCommitted} onError={onError} />;
}

function AddPreviewBody({ request, onClose, onCommitted, onError }: AddPreviewDialogProps & { request: AddPreviewRequest }) {
  const [preview, setPreview] = useState<GroceryPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewGroceryAdd({ data: { recipes: request.recipes, planWeek: request.planWeek } })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        // D9's default: everything except the staples.
        setSelected(new Set(result.rows.filter((row) => !row.isStaple).map((row) => row.key)));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Canonical aisle order, so the preview reads in the same sequence the list
  // will. `sort` is stable, so rows inside an aisle keep the server's order.
  const rows = useMemo(() => (preview ? [...preview.rows].sort((a, b) => aisleOrder(a.aisle) - aisleOrder(b.aisle)) : []), [preview]);

  const stapleCount = rows.filter((row) => row.isStaple).length;
  const count = selected.size;
  const source = request.label ?? describeRecipes(preview);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function commit() {
    if (!preview || count === 0 || committing) return;
    setCommitting(true);
    const picked = rows
      .filter((row) => selected.has(row.key))
      .map((row) => {
        const edit = edits[row.key];
        const quantity = edit?.quantity !== undefined ? edit.quantity : row.quantity;
        return {
          foodSlug: row.foodSlug,
          nameNorm: row.nameNorm,
          displayName: edit?.displayName ?? row.displayName,
          aisle: row.aisle,
          quantity,
          // An edited total replaces the range rather than keeping a stale upper
          // bound — the same call `editGroceryItem` makes server-side.
          quantityMax: edit?.quantity !== undefined ? null : row.quantityMax,
          unit: row.unit,
          unitDim: row.unitDim,
          mergeUnit: row.mergeUnit,
          sources: row.sources,
        };
      });

    commitGroceryAdd({ data: { rows: picked } })
      .then((result) => {
        onCommitted(result);
        onClose();
      })
      .catch((error: unknown) => {
        setCommitting(false);
        onError(error instanceof Error ? error.message : "That didn't save. Try again.");
      });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        {/* Title only, no glyph. Butter fill + ink border + a hard shadow is the
          app's "you can press this" sticker, and hanging it on a decorative
          basket taught that a dialog heading was a control. Dialogs across the
          app now carry no title iconography at all. */}
        <DialogTitle>Add to your shopping list</DialogTitle>
        <DialogDescription>{source}</DialogDescription>

        {preview === null && !failed && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted-foreground">
            <Spinner className="size-6" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">Reading the ingredients…</p>
          </div>
        )}

        {failed && (
          <div className="flex flex-col items-center gap-[5px] px-4 py-10 text-center text-muted-foreground">
            <UtensilsCrossed className="size-[26px]" aria-hidden="true" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">That didn't load.</p>
            <p className="m-0 text-xs">Nothing was added. Close this and try again.</p>
          </div>
        )}

        {preview !== null && rows.length === 0 && (
          <div className="flex flex-col items-center gap-[5px] px-4 py-10 text-center text-muted-foreground">
            <UtensilsCrossed className="size-[26px]" aria-hidden="true" />
            <p className="m-0 text-[0.8125rem] font-bold text-foreground">There's nothing to add.</p>
            <p className="m-0 text-xs">{request.planWeek ? "Nothing is planned for that week yet." : "These recipes don't list any ingredients."}</p>
          </div>
        )}

        {rows.length > 0 && (
          <>
            {/* Slats, like the list these rows are about to land on. Full-bleed
              past the dialog's own padding for the same reason the list's rows
              bleed past the page's: a bar that stops short of the edge reads as
              a card again, and cards in a gapped stack are N objects to compare
              rather than one column to scan. The container's top rule and the
              last row's own divider close the scrollport at both ends. */}
            <div className="-mx-6 max-h-[22rem] overflow-auto border-t-2 border-border/45">
              <ul className="m-0 flex list-none flex-col p-0">
                {rows.map((row) => (
                  <PreviewRow
                    key={row.key}
                    row={row}
                    edit={edits[row.key]}
                    checked={selected.has(row.key)}
                    editing={editingKey === row.key}
                    onToggle={() => toggle(row.key)}
                    onStartEdit={() => setEditingKey(row.key)}
                    onCancelEdit={() => setEditingKey(null)}
                    onSaveEdit={(patch) => {
                      setEditingKey(null);
                      setEdits((prev) => ({ ...prev, [row.key]: { ...prev[row.key], ...patch } }));
                      // Editing a row is a statement of intent to buy it; making
                      // the shopper then find the checkbox would be a second step
                      // for a decision they already made.
                      setSelected((prev) => new Set(prev).add(row.key));
                    }}
                  />
                ))}
              </ul>
            </div>

            <p className="m-0 text-[0.6875rem] font-semibold text-muted-foreground">
              {count === 0 ? "Nothing picked" : `${count} of ${rows.length} picked`}
              {stapleCount > 0 && ` · ${stapleCount} ${stapleCount === 1 ? "staple starts" : "staples start"} unchecked — check the ones you're out of`}
            </p>
          </>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={rows.length === 0 || count === 0 || committing} onClick={commit}>
            {committing ? "Adding…" : count > 0 ? `Add ${count} ${count === 1 ? "item" : "items"}` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Chicken pot pie · Weeknight soup", or "3 recipes" once that runs long. */
function describeRecipes(preview: GroceryPreview | null): string {
  if (!preview) return "Reading what these recipes need…";
  const titles = preview.recipes.map((recipe) => recipe.title);
  if (titles.length === 0) return "Nothing to pull in";
  if (titles.length <= 3) return titles.join(" · ");
  return `${titles.length} recipes`;
}

function PreviewRow({
  row,
  edit,
  checked,
  editing,
  onToggle,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  row: GroceryPreviewRow;
  edit: RowEdit | undefined;
  checked: boolean;
  editing: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (patch: RowEdit) => void;
}) {
  const displayName = edit?.displayName ?? row.displayName;
  const quantity = edit?.quantity !== undefined ? edit.quantity : row.quantity;
  const quantityDisplay = edit?.quantity !== undefined ? renderRowQuantity(row, edit.quantity) : row.quantityDisplay;

  if (editing) {
    return (
      <li className={cn(previewSlatVariants(), "bg-accent/40")}>
        <PreviewRowEditor row={{ ...row, quantity }} displayName={displayName} onCancel={onCancelEdit} onSave={onSaveEdit} />
      </li>
    );
  }

  return (
    <li className={cn(previewSlatVariants(), selectableRowVariants({ selected: false }))}>
      <label className="flex min-h-12 min-w-0 flex-1 cursor-(--cursor-interactive) items-center gap-3 py-2 pl-6">
        <Checkbox checked={checked} onChange={onToggle} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.8125rem] leading-snug">
            {quantityDisplay && <span className="font-bold text-foreground tabular-nums">{quantityDisplay}</span>}
            <span className="font-semibold text-foreground">{displayName}</span>
            {row.isStaple && (
              <Badge variant="outline" size="xs" className="text-[0.6rem]">
                staple
              </Badge>
            )}
          </span>
          {/* Wraps rather than truncates: the merge hint is the one thing here
            that changes what the shopper ends up with, and half of it read as
            "merges into a row you alread…" tells them nothing. */}
          <span className="text-[0.6875rem] font-medium text-balance text-muted-foreground">
            {AISLE_LABELS[row.aisle]}
            {row.mergesInto && " · merges into a row you have"}
            {row.sources.length > 1 && ` · ${row.sources.length} lines`}
          </span>
        </span>
      </label>
      <span className="flex flex-none items-center pr-4 pl-1">
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${displayName}`} onClick={onStartEdit}>
          <Pencil aria-hidden="true" />
        </Button>
      </span>
    </li>
  );
}

/** The same amount-in-its-own-unit edit the list rows use, in dialog density. */
function PreviewRowEditor({ row, displayName, onSave, onCancel }: { row: GroceryPreviewRow; displayName: string; onSave: (patch: RowEdit) => void; onCancel: () => void }) {
  const typed = editableQuantity(row);
  const [quantity, setQuantity] = useState(typed == null ? "" : String(typed));
  const [name, setName] = useState(displayName);
  const firstField = useRef<HTMLInputElement>(null);
  const unit = editableUnitLabel(row);

  useEffect(() => {
    firstField.current?.focus();
    firstField.current?.select();
  }, []);

  function submit() {
    const trimmed = name.trim();
    const raw = quantity.trim();
    const parsed = raw === "" ? null : Number(raw);
    onSave({
      displayName: trimmed === "" ? undefined : trimmed,
      quantity: parsed != null && !Number.isFinite(parsed) ? undefined : baseQuantity(row, parsed),
    });
  }

  // Escape cancels the row edit without closing the whole dialog, and it lives
  // on the fields rather than on the <form> — a key handler on a non-interactive
  // element is an a11y-lint error, and the form has no other way in anyway.
  function cancelOnEscape(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  }

  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-6 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        ref={firstField}
        size="sm"
        inputMode="decimal"
        className="w-16 flex-none tabular-nums"
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
        onKeyDown={cancelOnEscape}
        aria-label={`Amount of ${displayName}`}
        placeholder="—"
      />
      {unit && <span className="flex-none text-xs font-semibold text-muted-foreground">{unit}</span>}
      <Input
        size="sm"
        className="min-w-[6rem] flex-1"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={cancelOnEscape}
        aria-label={`Name for ${displayName}`}
      />
      <span className="flex flex-none items-center gap-1">
        <Button type="submit" size="xs">
          <Check data-icon="inline-start" aria-hidden="true" />
          Save
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
