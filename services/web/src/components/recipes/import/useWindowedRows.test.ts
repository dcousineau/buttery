import { describe, expect, it } from "vitest";
import { rowWindow, ROW_HEIGHT_ESTIMATE } from "./useWindowedRows.ts";

/**
 * The windowing arithmetic (plan §9, §10.3, §16.16).
 *
 * The hook around it needs a DOM; the slice does not, and the slice is where a windowing bug
 * lives — an off-by-one that only shows at one scroll offset, or an `end` past the array that
 * renders a hole. `ImportListPane` renders `items.slice(start, end)` and two spacers sized
 * from `start` and `count - end`, so these three numbers are the whole contract:
 *
 *   - every row the user can see is inside `[start, end)`
 *   - `start` never goes below 0 and `end` never goes past `count`
 *   - `topPad + rendered + bottomPad` always covers `count` rows exactly
 */

const ROW = ROW_HEIGHT_ESTIMATE;
/** A pane about 12 rows tall — the shipped review list at 1440×900. */
const VIEWPORT = ROW * 12;

function windowAt(scrollTop: number, count = 341, overscan = 8) {
  return rowWindow({ scrollTop, viewportHeight: VIEWPORT, count, rowHeight: ROW, overscan });
}

describe("rowWindow", () => {
  it("mounts a window, not the list", () => {
    const { start, end } = windowAt(0);
    expect(start).toBe(0);
    // 12 visible + 1 partial + 8 overscan. The point of the whole exercise: 21 of 341.
    expect(end).toBe(21);
    expect(end - start).toBeLessThan(30);
  });

  it("covers every visible row at an arbitrary scroll offset, plus overscan on both sides", () => {
    // Deliberately not a multiple of the row height: a row is half-cut at the top edge.
    const scrollTop = ROW * 100 + 30;
    const { start, end } = windowAt(scrollTop);

    const firstVisible = Math.floor(scrollTop / ROW);
    const lastVisible = Math.floor((scrollTop + VIEWPORT) / ROW);
    expect(start).toBeLessThanOrEqual(firstVisible);
    expect(end).toBeGreaterThan(lastVisible);
    expect(start).toBe(firstVisible - 8);
  });

  it("clamps at both ends of the list rather than slicing past it", () => {
    expect(windowAt(0).start).toBe(0);

    const atBottom = windowAt(ROW * 341, 341);
    expect(atBottom.end).toBe(341);
    expect(atBottom.start).toBeLessThan(341);
    // A scrollTop past the content (a shrunk list, a stale metric) must not produce an
    // inverted or out-of-range slice.
    const past = windowAt(ROW * 10_000, 341);
    expect(past.end).toBe(341);
    expect(past.start).toBe(341 - 1 - 8);
    expect(past.end).toBeGreaterThanOrEqual(past.start);
  });

  it("renders a screenful before the pane has been measured", () => {
    // First paint: `clientHeight` is 0 until layout. Rendering nothing here would flash an
    // empty list and, worse, leave nothing for the row measurement to measure.
    const { start, end } = rowWindow({ scrollTop: 0, viewportHeight: 0, count: 341, rowHeight: ROW });
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(10);
  });

  it("is empty for an empty group and never divides by a zero row height", () => {
    expect(rowWindow({ scrollTop: 0, viewportHeight: VIEWPORT, count: 0, rowHeight: ROW })).toEqual({ start: 0, end: 0 });
    expect(rowWindow({ scrollTop: 0, viewportHeight: VIEWPORT, count: 341, rowHeight: 0 })).toEqual({ start: 0, end: 0 });
  });

  it("keeps the spacers and the slice adding up to the whole list at every offset", () => {
    for (const scrollTop of [0, 1, ROW - 1, ROW, ROW * 7.5, ROW * 150, ROW * 340, ROW * 341]) {
      const { start, end } = windowAt(scrollTop);
      const rendered = end - start;
      const topRows = start;
      const bottomRows = 341 - end;
      expect(topRows + rendered + bottomRows).toBe(341);
      expect(bottomRows).toBeGreaterThanOrEqual(0);
    }
  });

  it("tracks a measured row height rather than the estimate", () => {
    // The hook replaces the estimate with the first row's real height; the slice has to move
    // with it or the window drifts from what is on screen.
    const measured = 53;
    const { start } = rowWindow({ scrollTop: measured * 100, viewportHeight: VIEWPORT, count: 341, rowHeight: measured, overscan: 8 });
    expect(start).toBe(92);
  });
});
