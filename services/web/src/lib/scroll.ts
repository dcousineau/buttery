/**
 * The scrollport an element actually sits in.
 *
 * App views scroll in two different places depending on width (see
 * `components/ui/pane.tsx`): an inner `overflow-auto` div from `md` up, the
 * window below it. Anything that parks the view programmatically has to ask
 * rather than assume — `parentElement.scrollTo` is a silent no-op on an element
 * that is not a scrollport, which is exactly what a phone gets.
 *
 * Computed `overflow-y` is the whole test: a `md:overflow-auto` box computes to
 * `visible` below that width, so the same walk answers correctly in both modes
 * without a breakpoint in JS.
 */
export function scrollportOf(el: HTMLElement): HTMLElement | Window {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return window;
}
