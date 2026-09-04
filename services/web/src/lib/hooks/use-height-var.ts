import { useCallback, useRef, type RefObject } from "react";

/**
 * Publishes an element's live height to a CSS custom property, so layout that
 * has to sit below a variable-height strip can be expressed in CSS instead of
 * being recomputed in React.
 *
 * Returns a *callback ref* rather than taking an object ref: a remount moves
 * the observed node, and an effect-bound observer would keep watching the
 * detached one — which fires a `0` resize on removal and collapses the offset.
 * Re-binding on every node change (and never writing on unmount) keeps the
 * variable pinned to whichever node is live.
 *
 * `target` is where the variable is written; it defaults to the document root
 * for app-wide offsets. Pass a ref for a scoped one so two panes on screen at
 * once can't overwrite each other.
 */
export function useHeightVar(name: string, target?: RefObject<HTMLElement | null>) {
  const observerRef = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const set = () => (target ? target.current : document.documentElement)?.style.setProperty(name, `${el.offsetHeight}px`);
      set();
      const observer = new ResizeObserver(set);
      observer.observe(el);
      observerRef.current = observer;
    },
    [name, target],
  );
}
