import { cva, type VariantProps } from "class-variance-authority";

/**
 * The app's one "this row is the selected one" treatment, for listbox-shaped lists —
 * the recipe box ledger, the bulk-import review list, and anything else that is a
 * column of uniform rows with exactly one current row.
 *
 * **Fill plus a leading butter bar.** `--accent` (butter-pale) fills the row and
 * `--shadow-selected` draws a 4px butter bar down its leading edge. That is the row
 * dialect of the same butter idea the card/nav dialect spells as fill + ink border +
 * `pop-sm` (see `radioCardVariants`, `AppSidebar`); rows can't use that one, because a
 * row sits flush against its neighbours inside a scrollport where a border resizes it
 * and a hard offset shadow lands on the row below. The marker is an inset shadow, so a
 * selected row occupies exactly the same box as an unselected one and moving the
 * selection never shifts the list.
 *
 * **Selection only.** Focus keeps whatever `focus-visible:` ring the call site already
 * has, and the two must stay tellable apart — a keyboard user arrowing through the list
 * can have focus on one row while the selection is still on another. Hover is the
 * quietest of the three (`accent` at 40%), so the ranking hover < selected reads at a
 * glance.
 *
 * Roles are the call site's business: a list of links is navigation and marks its
 * current row with `aria-current` (`"page"` when the row *is* the current page); a real
 * listbox marks it with `aria-selected`. This variant is the paint, not the semantics.
 */
const selectableRowVariants = cva("transition-colors", {
  variants: {
    selected: {
      true: "bg-accent shadow-selected",
      false: "hover:bg-accent/40",
    },
  },
  defaultVariants: { selected: false },
});

export { selectableRowVariants };
export type SelectableRowVariants = VariantProps<typeof selectableRowVariants>;
