import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Fixed-height row windowing for the review list (plan §9, §10.3, §16.16).
 *
 * §9 asks for virtualization or pagination at 341 rows and §10.3 leaves the choice open; D3
 * forbids a new dependency for it. Every row in this list is the same height by construction
 * — one truncated title, one truncated meta line, a fixed-size thumbnail — so the whole of
 * windowing is `floor(scrollTop / rowHeight)` plus an overscan, which is this file.
 *
 * What it replaces: `content-visibility: auto` on 341 live `<li>`s. That skips *paint* and
 * *layout* for offscreen rows but nothing else — React still reconciles every row, the DOM
 * still holds every element, and every thumbnail still calls `createObjectURL` on mount,
 * which is why `MAX_LIVE_URLS` had to be 1024. Under this hook only the mounted slice exists,
 * so the object-URL bound is proportionate to the window instead of to the export.
 *
 * Two things naive windowing breaks, handled here:
 *
 * - **Row height as a guess.** A hardcoded constant that disagrees with the rendered row
 *   makes the scrollbar lie and the window drift. The first mounted row is measured
 *   (`measureRow`) and the measurement replaces the estimate, so the constant only has to be
 *   close enough for the first frame.
 * - **Keyboard reach.** Tab only reaches mounted rows once the rest are gone, so the list
 *   grows real arrow-key navigation: `scrollRowIntoView` puts the target row inside the
 *   window *before* React renders it, and the caller focuses it afterwards. See
 *   `ImportListPane`.
 */

/** The estimate before the first row is measured. Replaced by a real measurement on mount. */
export const ROW_HEIGHT_ESTIMATE = 69;

/** Rows rendered above and below the viewport. Covers a fast flick between frames. */
const OVERSCAN = 8;

export interface RowWindow {
  /** First row index to render (inclusive). */
  start: number;
  /** Last row index to render (exclusive). */
  end: number;
}

/**
 * The slice to render for a scroll position. Pure, so the arithmetic is unit-testable without
 * a DOM — a windowing bug is an off-by-one that only shows up at one scroll offset.
 */
export function rowWindow({ scrollTop, viewportHeight, count, rowHeight, overscan = OVERSCAN }: { scrollTop: number; viewportHeight: number; count: number; rowHeight: number; overscan?: number }): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  // Before the first measurement the pane has no height yet; render a screenful rather than
  // nothing, so the first paint is never an empty list.
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 12;
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(height / rowHeight) + 1;
  const start = Math.max(0, Math.min(first, count - 1) - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(end, start) };
}

export interface WindowedRows extends RowWindow {
  /** Ref for the scrolling element. Its `clientHeight` is the viewport. */
  scrollRef: React.RefObject<HTMLUListElement | null>;
  /** Wire to the scroller's `onScroll`. */
  onScroll: () => void;
  /** Ref callback for any rendered row; the first one measured sets the real row height. */
  measureRow: (element: HTMLElement | null) => void;
  /** Height in px of the spacer standing in for the rows above the window. */
  topPad: number;
  /** Height in px of the spacer standing in for the rows below it. */
  bottomPad: number;
  /** Scroll `index` into view **synchronously**, so the next render already includes it. */
  scrollRowIntoView: (index: number) => void;
  /** The row height in use — measured if a row has been seen, the estimate otherwise. */
  rowHeight: number;
}

/**
 * @param count number of rows in the list
 * @param resetKey changing it scrolls back to the top (the list swapped out from under us)
 */
export function useWindowedRows({ count, resetKey }: { count: number; resetKey?: string }): WindowedRows {
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_ESTIMATE);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 });
  const frame = useRef<number | null>(null);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setMetrics((prev) => (prev.scrollTop === el.scrollTop && prev.viewportHeight === el.clientHeight ? prev : { scrollTop: el.scrollTop, viewportHeight: el.clientHeight }));
  }, []);

  // Scroll events fire faster than frames; coalescing to one read per frame keeps a flick
  // from queueing dozens of identical state updates.
  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      sync();
    });
  }, [sync]);

  useEffect(() => () => void (frame.current !== null && cancelAnimationFrame(frame.current)), []);

  // The pane's height is not known until it is laid out, and it changes with the window.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sync]);

  // A different list in the same scroller keeps the old scrollTop, which would open the new
  // group part-way down — invisible with 341 rows, and the sort of thing that reads as a bug.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setMetrics({ scrollTop: 0, viewportHeight: el.clientHeight });
  }, [resetKey]);

  const measureRow = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const height = element.getBoundingClientRect().height;
    // Sub-pixel jitter is not a new row height.
    if (height > 0) setRowHeight((prev) => (Math.abs(prev - height) < 0.5 ? prev : height));
  }, []);

  const scrollRowIntoView = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      // Read it back in the same tick: the caller is about to select this row and focus it,
      // and the render that mounts it has to happen in this batch or the focus finds nothing.
      setMetrics({ scrollTop: el.scrollTop, viewportHeight: el.clientHeight });
    },
    [rowHeight],
  );

  const { start, end } = rowWindow({ scrollTop: metrics.scrollTop, viewportHeight: metrics.viewportHeight, count, rowHeight });

  return {
    scrollRef,
    onScroll,
    measureRow,
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (count - end) * rowHeight),
    scrollRowIntoView,
    rowHeight,
  };
}
