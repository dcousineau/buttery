import { Check, CookingPot, EyeOff, Lock } from "lucide-react";
import { useRef, useState } from "react";
import type { PlanEntry } from "#/server/meal-plan";
import type { MealSlot, PlanDate } from "#/lib/plan/week";
import { SLOT_LABELS, formatPlanDate } from "#/lib/plan/labels";
import { Popover, PopoverTrigger } from "#/components/ui/popover";
import { PlanEntryPopover } from "./PlanEntryPopover";
import type { PlanEntryActionIntent } from "./PlanEntryPopover";
import { usePlanActions } from "./PlanActions";
import { isOptimisticId } from "./optimistic";
import { useTextSafeDrag } from "#/lib/hooks/use-drag-source";
import { cn } from "#/lib/utils";

/**
 * One planned entry — a recipe or a free-text note — as drawn in both the week
 * grid and the days agenda.
 *
 * The card is the interaction surface for everything you can do to an entry: it
 * is draggable (native HTML5 DnD, no library) and it is the `Popover.Trigger`
 * for the action popover, so click / Enter / Space toggle it. It renders as a
 * `role="button"` div (`render={<div/>} nativeButton={false}`) rather than a
 * `<button>` because it contains its own buttons (the agenda's cook/cooked
 * shortcuts, the note's more/less toggle) and nested interactive content is
 * invalid inside a button. Base UI's non-native button handling only fires on
 * `event.target === event.currentTarget`, so those nested controls keep their
 * own keyboard behaviour.
 *
 * A card the server has not confirmed yet (an optimistic add) is inert: it
 * cannot be dragged and its shortcuts are disabled, because the id it is wearing
 * is a client-side placeholder no server function would recognise. That lasts
 * only until the reconciling `router.invalidate()` lands.
 */

/** How many characters of a note survive before the more/less toggle appears. */
const NOTE_CLAMP = 140;

interface PlanEntryCardProps {
  entry: PlanEntry;
  date: PlanDate;
  slot: MealSlot;
  /** The grid is denser and clamps notes; the agenda gets the cook shortcuts. */
  variant: "grid" | "days";
  /** Dims the card (past days stay fully editable — D6). */
  isPast?: boolean;
}

export function PlanEntryCard({ entry, date, slot, variant, isPast = false }: PlanEntryCardProps) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The cell (grid cell or agenda slot row) this card sits in, recorded from the
  // trigger's ref because after a remove the card is gone and there is nothing
  // left to walk up from. It is a callback ref, not `ref={someRef}`:
  // `Popover.Trigger` is typed for the `<button>` it renders by default, and
  // this one is a `<div>`.
  const cellRef = useRef<Element | null>(null);

  const actions = usePlanActions();
  const isNote = entry.kind === "note";
  const isDays = variant === "days";
  const cooked = entry.kind === "recipe" && entry.cookedAt !== null;
  const pending = isOptimisticId(entry.id);
  // The whole card is the drag source, so any text control it ever grows (an
  // inline note edit, say) would lose click-and-drag selection to the card drag.
  // This stands the card down for a press that begins inside one.
  const dragProps = useTextSafeDrag(!pending);

  /**
   * Escape and outside-press dismissal are the primitive's now; the only case it
   * cannot handle is "Remove", where the trigger it would hand focus back to has
   * just been optimistically unmounted and focus would land on `<body>`. The
   * owning cell's add button is the nearest thing that survives, so we focus it
   * once the popup has gone. `setTimeout` and not `requestAnimationFrame`: Base
   * UI restores focus from a microtask, so a task is the first slot that is
   * reliably after it, and a frame callback never runs at all while the window
   * is occluded. The cell comes from `cellRef` rather than from the card,
   * because `plan.removeEntry` has already unmounted the card by this point.
   */
  function handleAction(intent: PlanEntryActionIntent) {
    if (intent === "remove") {
      const fallback = cellRef.current?.querySelector<HTMLElement>("[data-plan-add]") ?? null;
      if (fallback) setTimeout(() => fallback.focus());
    }
    setOpen(false);
  }

  const body = isNote ? entry.body : "";
  // Both views clamp at the same length so the "more" affordance does not appear
  // and disappear as the layout switches under the user.
  const clamped = isNote && body.length > NOTE_CLAMP;
  const shownBody = isNote && clamped && !expanded ? `${body.slice(0, NOTE_CLAMP).trimEnd()}…` : body;

  const meta = metaParts(entry);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={(node: HTMLElement | null) => {
          if (node) cellRef.current = node.closest("[data-plan-slot]");
        }}
        nativeButton={false}
        render={<div />}
        {...dragProps}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", entry.id);
          setDragging(true);
          setOpen(false);
          actions.setDraggingId(entry.id);
        }}
        onDragEnd={() => {
          setDragging(false);
          actions.setDraggingId(null);
          actions.setDragOverSlot(null);
        }}
        className={cn(
          // `relative` is load-bearing, not decoration: the day/slot `sr-only`
          // span below is `position: absolute`, and with no positioned ancestor
          // inside the scroller its containing block became the page shell — so
          // it escaped the grid's `overflow-x` and gave the whole document a
          // horizontal scrollbar at widths where the 46rem grid does not fit.
          "relative flex w-full cursor-grab border-2 text-left transition-opacity hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          // The agenda has room for a roomier card and the cook shortcuts; the
          // grid cell is 62px tall and gets the tight one.
          isDays ? "items-center gap-2 rounded-lg px-[9px] py-[5px]" : "items-start gap-[5px] rounded-sm px-1.5 py-1",
          isNote ? "border-border/40 bg-muted/60 shadow-none" : "border-border bg-card shadow-pop-sm",
          entry.kind === "recipe" && !entry.inBox && "border-border/40",
          isPast && "opacity-65",
          dragging && "cursor-grabbing opacity-45",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 flex-wrap items-center gap-[5px]">
            <span
              className={cn(
                "min-w-0 break-words",
                isDays ? "text-[0.8125rem] leading-[1.35]" : "text-[0.6875rem] leading-[1.25]",
                isNote ? "font-medium" : "font-bold",
                (isNote || cooked) && "text-muted-foreground",
                cooked && "line-through",
                // Notes in the agenda expand in place — a CSS clamp there would
                // make the more/less toggle do nothing.
                isDays && isNote ? "" : "line-clamp-2",
              )}
            >
              {isNote ? shownBody : entry.title}
            </span>
            {isDays && <PlanEntryFlags entry={entry} scope="card" />}
          </span>

          {meta.length > 0 && <span className={cn("font-semibold text-muted-foreground", isDays ? "text-[0.6875rem]" : "text-[0.625rem]")}>{meta.join(" · ")}</span>}

          {!isDays && <PlanEntryFlags entry={entry} scope="card" />}

          {isNote && clamped && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              className="w-fit text-[0.6875rem] font-bold text-muted-foreground underline underline-offset-2"
            >
              {expanded ? "less" : "more"}
            </button>
          )}

          {/* Cells convey day and slot visually only; without this a card read on
              its own would not say where in the week it sits. */}
          <span className="sr-only">
            {SLOT_LABELS[slot]}, {formatPlanDate(date)}
          </span>
        </span>

        {isDays && entry.kind === "recipe" && (
          <span className="flex shrink-0 items-center gap-1">
            {/* §7.5: straight into the apron, opened over the week rather than
                navigated to — cook mode is a fullscreen modal, so exiting it
                hands the plan back. `stopPropagation` keeps the click off the
                card's popover. */}
            <button
              type="button"
              title="Start cook mode"
              aria-label={`Start cook mode for ${entry.title}`}
              onClick={(event) => {
                event.stopPropagation();
                actions.startCook(entry.recipeId);
              }}
              className="inline-flex size-[26px] items-center justify-center rounded-sm border-2 border-border bg-card text-foreground hover:bg-accent"
            >
              <CookingPot className="size-[13px]" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={pending}
              aria-pressed={cooked}
              title={cooked ? "Not cooked after all" : "Mark cooked"}
              aria-label={cooked ? `Mark ${entry.title} not cooked` : `Mark ${entry.title} cooked`}
              onClick={(event) => {
                event.stopPropagation();
                actions.setCooked(entry.id, !cooked);
              }}
              className={cn(
                "inline-flex size-[26px] items-center justify-center rounded-sm border-2 border-border disabled:opacity-50",
                cooked ? "bg-secondary text-secondary-foreground" : "bg-card text-muted-foreground",
              )}
            >
              <Check className="size-[13px]" aria-hidden="true" />
            </button>
          </span>
        )}
      </PopoverTrigger>

      <PlanEntryPopover entry={entry} date={date} slot={slot} variant={variant} onAction={handleAction} />
    </Popover>
  );
}

/**
 * The provenance flags.
 *
 * `scope="card"` shows only "not in box" — the one flag that changes what you
 * can do with the entry from the card itself. `scope="popover"` adds the two
 * availability flags, using the recipes-index vocabulary (eye-off = the source
 * went away, lock = never published) so the same condition looks the same
 * wherever the user meets it.
 */
export function PlanEntryFlags({ entry, scope }: { entry: PlanEntry; scope: "card" | "popover" }) {
  if (entry.kind !== "recipe") return null;
  const showAvailability = scope === "popover";
  const flags = [
    !entry.inBox ? { key: "box", label: "not in box", icon: null, tone: "muted" as const } : null,
    showAvailability && entry.unavailable ? { key: "unavailable", label: "source unavailable", icon: EyeOff, tone: "destructive" as const } : null,
    showAvailability && entry.unpublished ? { key: "unpublished", label: "private draft", icon: Lock, tone: "secondary" as const } : null,
  ].filter((flag) => flag !== null);

  if (flags.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {flags.map((flag) => (
        <span
          key={flag.key}
          className={cn(
            "inline-flex items-center gap-1 rounded-4xl border-2 px-1.5 py-px text-[0.5625rem] font-bold tracking-wide uppercase",
            flag.tone === "destructive" && "border-destructive/40 bg-destructive/10 text-destructive",
            flag.tone === "secondary" && "border-border bg-secondary text-secondary-foreground",
            flag.tone === "muted" && "border-border/40 bg-muted text-muted-foreground",
          )}
        >
          {flag.icon && <flag.icon className="size-[9px] shrink-0" aria-hidden="true" />}
          {flag.label}
        </span>
      ))}
    </span>
  );
}

/** The card's one-line meta, joined with " · " exactly as the comp draws it. */
function metaParts(entry: PlanEntry): string[] {
  if (entry.kind === "note") return entry.addedByHandle ? [`noted by ${entry.addedByHandle}`] : [];
  const parts: string[] = [];
  if (entry.totalTimeDisplay) parts.push(entry.totalTimeDisplay);
  if (entry.cookedAt) parts.push(entry.cookedByHandle ? `cooked by ${entry.cookedByHandle}` : "cooked");
  return parts;
}
