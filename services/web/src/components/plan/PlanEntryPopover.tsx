import { Link } from "@tanstack/react-router";
import { BookOpenText, Check, ChevronRight, Clock, CookingPot, Pencil, Trash2, Users, UtensilsCrossed } from "lucide-react";
import type { ComponentType } from "react";
import type { PlanEntry } from "#/server/meal-plan";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { slotDayLine } from "#/lib/plan/labels";
import { SourceLink } from "#/components/recipes/SourceLink";
import { PopoverContent } from "#/components/ui/popover";
import { PlanEntryFlags } from "./PlanEntryCard";
import { usePlanActions } from "./PlanActions";
import { isOptimisticId } from "./optimistic";
import { cn } from "#/lib/utils";

/**
 * The per-card action popover (design comp, both views).
 *
 * It is the `ui/popover` primitive (Base UI), NOT a hand-positioned `absolute`
 * box. The card lives inside two clipping ancestors — the week grid's rounded
 * container and the page's scrolling content column — and an absolutely
 * positioned descendant of either gets cut off, which is exactly the bug users
 * reported. The primitive portals to `document.body` and does its own collision
 * detection, so the popover can never be clipped by an ancestor and it flips
 * side/alignment on its own instead of the old `dayIndex >= 4 ? right : left`
 * guess. `side="bottom" sideOffset={6}` reproduces the comp's
 * `top: calc(100% + 6px)`.
 *
 * `PopoverRoot`/`PopoverTrigger` live on `PlanEntryCard` — the card IS the
 * trigger — so this file renders only the popup.
 *
 * Every item acts and then dismisses: the menu describes the entry it is
 * attached to, and after "Remove" or "Move to…" that entry is not there any
 * more. "Open recipe" is a real `<Link>` rather than a button that navigates, so
 * it can be opened in a new tab and reads as a link to assistive tech; "Start
 * cook mode" is a button, because it opens a modal in place and goes nowhere.
 */

/**
 * What the card has to do about focus once the item has run. `"remove"` unmounts
 * the card the popover would otherwise hand focus back to, so the owning cell
 * has to catch it instead.
 */
export type PlanEntryActionIntent = "default" | "remove";

interface PlanEntryPopoverProps {
  entry: PlanEntry;
  date: PlanDate;
  slot: MealSlot;
  /** Grid cards get the 16.5rem popover, agenda cards the 17rem one. */
  variant: "grid" | "days";
  /** Close the popover and hand focus back to the card (or, after a remove, to the cell). */
  onAction: (intent: PlanEntryActionIntent) => void;
}

interface MenuAction {
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  destructive?: boolean;
  run: () => void;
  intent?: PlanEntryActionIntent;
}

const menuItemClass =
  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-popover-foreground no-underline outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

const destructiveItemClass = "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive";

export function PlanEntryPopover({ entry, date, slot, variant, onAction }: PlanEntryPopoverProps) {
  const plan = usePlanActions();
  const isNote = entry.kind === "note";
  const cooked = entry.kind === "recipe" && entry.cookedAt !== null;
  // An entry the server has not confirmed yet has a placeholder id; nothing can
  // be done to it until the invalidate swaps in the real one.
  const pending = isOptimisticId(entry.id);

  // Same order the comp lists them in; "Add back to your box" only appears when
  // the recipe has left the box (plan §3.4).
  const actions: MenuAction[] = isNote
    ? [{ label: "Edit this note", icon: Pencil, run: () => plan.openNoteEditor(entry.id) }]
    : [
        { label: cooked ? "Not cooked after all" : "Mark cooked", icon: Check, run: () => plan.setCooked(entry.id, !cooked) },
        ...(entry.kind === "recipe" && !entry.inBox ? [{ label: "Add back to your box", icon: BookOpenText, run: () => plan.addBackToBox(entry.id) }] : []),
      ];
  actions.push({ label: "Move to…", icon: ChevronRight, run: () => plan.openMove(entry.id) });
  actions.push({ label: "Remove", icon: Trash2, destructive: true, intent: "remove", run: () => plan.removeEntry(entry.id) });

  return (
    <PopoverContent
      aria-label={isNote ? "Note actions" : entry.title}
      side="bottom"
      sideOffset={6}
      align="start"
      className={cn("flex flex-col p-0", variant === "grid" ? "w-[16.5rem]" : "w-[17rem]")}
    >
      <div className="flex flex-col gap-[7px] border-b-2 border-border bg-card p-2.5">
        <span className="text-[0.625rem] font-bold tracking-wide text-muted-foreground uppercase">{slotDayLine(slot, date)}</span>

        {entry.kind === "recipe" ? (
          <>
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border-2 border-border bg-muted">
              {entry.imageUrl ? (
                <img src={entry.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                  <UtensilsCrossed className="size-[34px]" aria-hidden="true" />
                </span>
              )}
            </div>
            <span className="display-title text-base leading-[1.15] text-pretty">{entry.title}</span>
          </>
        ) : (
          <span className="text-[0.8125rem] leading-[1.45] font-medium text-pretty text-foreground">{entry.body}</span>
        )}

        <div className="flex flex-col gap-[3px] text-[0.6875rem] font-semibold text-muted-foreground">
          {entry.kind === "recipe" && entry.totalTimeDisplay && (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-3 shrink-0" aria-hidden="true" />
              {entry.totalTimeDisplay}
            </span>
          )}
          {entry.kind === "recipe" && <SourceLink source={entry.source} className="gap-1.5" iconClassName="size-3" />}
          {entry.addedByHandle && (
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-3 shrink-0" aria-hidden="true" />
              Added by {entry.addedByHandle}
            </span>
          )}
          {entry.kind === "recipe" && entry.cookedAt && (
            <span className="inline-flex items-center gap-1.5">
              <Check className="size-3 shrink-0" aria-hidden="true" />
              Cooked{entry.cookedByHandle ? ` by ${entry.cookedByHandle}` : ""}
            </span>
          )}
        </div>

        {/* The popover carries the full provenance picture; the card carries only
            the one flag that changes what you can do with the entry. */}
        <PlanEntryFlags entry={entry} scope="popover" />
      </div>

      <div role="menu" className="flex flex-col p-1">
        {entry.kind === "recipe" && (
          <Link role="menuitem" to="/household/recipes/$id" params={{ id: entry.recipeId }} className={menuItemClass}>
            <BookOpenText aria-hidden="true" />
            Open recipe
          </Link>
        )}
        {/* §7.5: the apron opens over the week, so it is a button rather than a
          link — there is nowhere to navigate to, and closing cook mode hands the
          plan back instead of stranding someone on the recipe page. */}
        {entry.kind === "recipe" && (
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              plan.startCook(entry.recipeId);
              onAction("default");
            }}
          >
            <CookingPot aria-hidden="true" />
            Start cook mode
          </button>
        )}
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={() => {
              action.run();
              onAction(action.intent ?? "default");
            }}
            className={cn(menuItemClass, action.destructive && destructiveItemClass)}
          >
            <action.icon aria-hidden="true" />
            {action.label}
          </button>
        ))}
      </div>
    </PopoverContent>
  );
}
