import { createContext, use, useRef, type ReactNode } from "react";
import { useHeightVar } from "#/lib/hooks/use-height-var";
import { cn } from "#/lib/utils";

/**
 * The app views' shared furniture: the column an app view lives in, the one
 * scrollport inside it, and the white strips that head it.
 *
 * Every `/household/*` surface was building the same three pieces by hand — the
 * `100svh - header` column, an `overflow-auto` scrollport, and one or more
 * `bg-card` heads above it. They live here now, and with them the one behaviour
 * the hand-built version could not have: a head that gets out of the way.
 *
 * ## Two scroll models, split at `md`
 *
 * **Below `md` the DOCUMENT scrolls.** The scrollport is an ordinary block, the
 * column is a minimum height rather than a fixed one, and `main` stops clipping
 * (`AppShell`). This is the mobile-native shape: a phone shows one column
 * anyway — the collections tree, the detail pane and the planner's aside are all
 * `md:`/`lg:` — so the inner scrollport was buying nothing there while costing
 * the thing a browser only does for document scroll: retracting its own
 * toolbar. Scrolling a recipe now reclaims the pane head *and* ~50–100px of
 * Safari chrome.
 *
 * **From `md` up the pane scrolls**, exactly as before, because that is where
 * two columns sit side by side and have to scroll independently.
 *
 * The consequence to remember when adding sticky furniture: below `md` a
 * sticky element's viewport is the window, and the app header is `fixed` over
 * the top of it — so anything sticky parks at `var(--header-offset)` there (how
 * much of the header is showing, which headroom drives to 0 as it slides away)
 * and at `0` from `md` up, where the scrollport's top edge is already below it.
 *
 * ## Collapse on scroll
 *
 * A `PaneHeader` is either **pinned** (`sticky`, the default — it never leaves)
 * or **collapsing** (`collapseOnScroll`, ordinary flow — it scrolls off the top
 * with the content and comes back when you return to the top). That is the
 * whole mechanism: no scroll listener, no measured direction, no state. Scroll
 * position IS the state, so the head can never disagree with the content under
 * it, and a fling-scroll cannot leave it half-open.
 *
 * The two kinds compose, which is the point of the prop: the shopping list
 * collapses its title but pins "add an item", the recipe box pins the search
 * field but collapses the collections trigger above it. Order in the DOM is
 * order on screen — put the collapsing head first and the pinned one after it,
 * and the pinned one takes over the top edge as the first scrolls away.
 *
 * A pinned head publishes its height as `--pane-pinned-height` on the
 * scrollport, so anything with sticky furniture of its own (grocery aisle
 * headings) can park below it rather than under it.
 */

const PaneScrollerContext = createContext<{ ref: React.RefObject<HTMLDivElement | null> } | null>(null);

/** The column an app view lives in: viewport-height and non-scrolling from `md`
 * up, a minimum height below it so the page grows with its content. */
export function Pane({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-h-[calc(100svh-var(--header-height,4rem))] w-full md:h-[calc(100svh-var(--header-height,4rem))] md:min-h-0", className)}>{children}</div>;
}

/**
 * The pane's scrollport from `md` up; an ordinary block below it, where the
 * document is the scrollport.
 *
 * `relative` is load-bearing rather than decoration: `main` is `overflow-hidden`
 * at those widths but unpositioned, so absolutely positioned descendants (every
 * `.sr-only` span is one) would otherwise resolve against a box outside the
 * clip, escape it, and extend the *document* — a second, whole-page scrollbar
 * that slides the app view off the top.
 */
export function PaneScroller({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <PaneScrollerContext value={{ ref }}>
      <div ref={ref} className={cn("relative flex flex-col md:min-h-0 md:flex-1 md:overflow-auto", className)}>
        {children}
      </div>
    </PaneScrollerContext>
  );
}

/**
 * A white head inside a {@link PaneScroller}. Padding is the caller's — these
 * strips run from a 2px-tall filter bar to a wrapping title row — but the fill,
 * the rule under it and the scroll behaviour are not.
 */
export function PaneHeader({ collapseOnScroll = false, className, children }: { collapseOnScroll?: boolean; className?: string; children: ReactNode }) {
  const scroller = use(PaneScrollerContext);
  const pinnedHeightRef = useHeightVar("--pane-pinned-height", scroller?.ref);
  return (
    <div
      ref={collapseOnScroll ? undefined : pinnedHeightRef}
      className={cn(
        "flex-none border-b-2 border-border bg-card",
        // Below `md` the window is the scrollport and the app header is fixed
        // over its top edge, so a pinned head parks under whatever of the header
        // is currently showing (`--header-offset`, which headroom drives to 0 as
        // the bar slides away — the head rises to the top edge with it). From
        // `md` up the scrollport already starts below the header.
        !collapseOnScroll && "sticky top-[var(--header-offset)] z-20 md:top-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The scrolling body under the heads. Fills the scrollport when the content is
 * shorter than it, so an empty or loading state can still centre itself. */
export function PaneBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-1 flex-col", className)}>{children}</div>;
}
