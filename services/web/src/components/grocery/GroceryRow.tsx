import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cva } from "class-variance-authority";
import { Check, Pencil, Trash2 } from "lucide-react";
import type { GroceryItemRow } from "#/lib/api";
import { OFFLINE_WRITE_HINT } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import { selectableRowVariants } from "#/components/ui/selectable-row";
import { cn } from "#/lib/utils";
import { baseQuantity, editableQuantity, editableUnitLabel } from "./optimistic";

/**
 * One line of the shopping list — a **slat**, not a card.
 *
 * Same construction the recipe ledger uses (`RecipeSlat`): a flush, full-bleed
 * bar with a hairline divider to its neighbours, no radius, no box, no shadow.
 * Cards in a gapped stack read as N separate objects you compare; slats read as
 * one ledger you scan, and scanning a list top to bottom is the entire job here.
 * The row paint comes from `selectableRowVariants` — the domain-free half of
 * that construction — rather than a fourth hand-rolled `hover:bg-accent/40`.
 *
 * It composes that primitive instead of importing `RecipeSlat` itself for the
 * reason `RecipeSlat`'s own doc gives for living in `components/recipes/`: its
 * slots are recipe-shaped (thumbnail, title with state icons, source line,
 * trailing metadata), and its type scale is tuned for a 360px rail — 13px on the
 * title line. A shopping list is read at arm's length in a store with a phone in
 * one hand, so the title line stays at body size and the bar keeps a 3.5rem
 * floor. Selection is not part of it either: no grocery row is ever "the current
 * one", so `selected` stays false and only the hover half of the variant is used.
 *
 * Sized for the actual use: a phone held in one hand, in a store, tapped with a
 * thumb while the other arm holds a basket. The whole label — checkbox, amount,
 * name and the recipes that put it there — is one hit target well past 44px
 * tall, and the two icon actions sit outside it so a mis-tap on "remove" is not
 * something a thumb does on the way to checking something off.
 *
 * **Checked rows dim in place and nothing strikes through** (plan §8), matching
 * `MisePhase`'s treatment. That is why this is not `CheckboxRow`, which is the
 * right primitive everywhere else in the app but bakes in the strike-through —
 * and could not host the remove button anyway, since a `<button>` inside the
 * row's `<label>` would toggle the checkbox on its way to firing.
 *
 * Inline edit covers quantity and display name only. Aisle is not editable, and
 * neither is the unit — it is the merge anchor the row was built on, so retyping
 * `lb` as `cups` would ask the engine for a conversion it refuses to make (D5).
 */

/**
 * The bar itself. `border-b-2 border-border/45` is the same ledger divider the
 * recipe slat draws, and every row carries one — including the last of an aisle,
 * where it becomes the rule the next aisle's sticky heading sits on.
 */
const grocerySlatVariants = cva("flex items-stretch border-b-2 border-border/45");

export interface GroceryRowProps {
  item: GroceryItemRow;
  onToggle: (checked: boolean) => void;
  /** `quantity` is in BASE units — the form converts before calling. */
  onEdit: (patch: { displayName?: string; quantity?: number | null }) => void;
  onRemove: () => void;
  /**
   * False while the browser is offline (offline plan §4.1). M1 ships offline
   * READS; the checkbox is the first thing M2 queues, because `{itemId, checked}`
   * is already an absolute write and replays safely by shape (§2.5). Until then a
   * disabled checkbox is the honest answer — a tap that silently did nothing is
   * the failure this whole plan exists to remove.
   */
  writable?: boolean;
}

/** "Chicken pot pie · Weeknight soup", or "Added by hand" for a typed line. */
function sourceLine(item: GroceryItemRow): string | null {
  const titles = [...new Set(item.sources.map((source) => source.title).filter((title): title is string => Boolean(title)))];
  if (titles.length) return titles.join(" · ");
  return item.isManual ? "Added by hand" : null;
}

export function GroceryRow({ item, onToggle, onEdit, onRemove, writable = true }: GroceryRowProps) {
  const [editing, setEditing] = useState(false);
  const checked = item.checkedAt != null;
  const sources = sourceLine(item);

  return (
    <li
      data-checked={checked}
      className={cn(
        grocerySlatVariants(),
        selectableRowVariants({ selected: false }),
        // Dim in place. No line-through, no reordering — a checked row keeps its
        // spot so the aisle you are standing in still reads the same.
        checked && "bg-muted/40 opacity-65",
      )}
    >
      {editing ? (
        <GroceryRowEditor
          item={item}
          onCancel={() => setEditing(false)}
          onSave={(patch) => {
            setEditing(false);
            onEdit(patch);
          }}
        />
      ) : (
        <>
          <label
            title={writable ? undefined : OFFLINE_WRITE_HINT}
            className={cn("flex min-h-[3.5rem] min-w-0 flex-1 items-center gap-3 py-2 pl-3 md:pl-4", writable && "cursor-(--cursor-interactive)")}
          >
            <Checkbox size="lg" checked={checked} disabled={!writable} onChange={(event) => onToggle(event.target.checked)} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-snug">
                {item.quantityDisplay && <span className="font-bold text-foreground tabular-nums">{item.quantityDisplay}</span>}
                <span className="font-semibold text-foreground">{item.displayName}</span>
              </span>
              {(sources || item.checkedByHandle) && (
                <span className="truncate text-xs font-medium text-muted-foreground">
                  {[sources, checked && item.checkedByHandle ? `In the cart · ${item.checkedByHandle}` : null].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
          </label>

          <span className="flex flex-none items-center gap-0.5 pr-1.5 pl-1 md:pr-2.5">
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={`Edit ${item.displayName}`}
              disabled={!writable}
              title={writable ? undefined : OFFLINE_WRITE_HINT}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={`Remove ${item.displayName}`}
              disabled={!writable}
              title={writable ? undefined : OFFLINE_WRITE_HINT}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </span>
        </>
      )}
    </li>
  );
}

/**
 * The edit form. Mounted only while editing, so the drafts start from the row's
 * current values every time and there is nothing to reset on close.
 *
 * The quantity field speaks the row's own unit rather than the base units the
 * row is stored in — a row reading `1 lb 8 oz` opens as `1.5` beside a fixed
 * `lb`. Emptying it means "I don't know how much", which the server stores as a
 * null quantity rather than refusing the edit.
 */
function GroceryRowEditor({ item, onSave, onCancel }: { item: GroceryItemRow; onSave: (patch: { displayName?: string; quantity?: number | null }) => void; onCancel: () => void }) {
  const typed = editableQuantity(item);
  const [quantity, setQuantity] = useState(typed == null ? "" : String(typed));
  const [name, setName] = useState(item.displayName);
  const firstField = useRef<HTMLInputElement>(null);
  const unit = editableUnitLabel(item);

  // `autoFocus` is banned by the a11y lint rules (and rightly — it moves focus
  // on mount, unasked). Here the mount IS the user's request to edit, so focus
  // follows the tap the same way it would in a dialog.
  useEffect(() => {
    firstField.current?.focus();
    firstField.current?.select();
  }, []);

  function submit() {
    const trimmed = name.trim();
    const raw = quantity.trim();
    const parsed = raw === "" ? null : Number(raw);
    // A field with letters in it is not a correction, it is a typo — keep the
    // row's current amount rather than storing NaN or clearing it.
    const nextQuantity = parsed != null && !Number.isFinite(parsed) ? undefined : baseQuantity(item, parsed);
    onSave({
      displayName: trimmed === "" ? undefined : trimmed,
      quantity: nextQuantity,
    });
  }

  // Escape lives on the fields rather than on the <form>: a key handler on a
  // non-interactive element is both an a11y-lint error and a real trap, since
  // the form is only reachable through the controls inside it anyway.
  function cancelOnEscape(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") onCancel();
  }

  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 px-3 py-2 md:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        ref={firstField}
        size="lg"
        inputMode="decimal"
        className="w-20 flex-none tabular-nums"
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
        onKeyDown={cancelOnEscape}
        aria-label={`Amount of ${item.displayName}`}
        placeholder="—"
      />
      {unit && <span className="flex-none text-sm font-semibold text-muted-foreground">{unit}</span>}
      {/* A 9rem floor on the name is what pushes the buttons onto a second line
        on a phone rather than squeezing "chicken breast" down to "chicken br…".
        On anything wider the whole form still fits one line. */}
      <Input
        size="lg"
        className="min-w-[9rem] flex-1"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={cancelOnEscape}
        aria-label={`Name for ${item.displayName}`}
      />
      <span className="ml-auto flex flex-none items-center gap-1">
        <Button type="submit" size="sm" aria-label={`Save ${item.displayName}`}>
          <Check data-icon="inline-start" aria-hidden="true" />
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
