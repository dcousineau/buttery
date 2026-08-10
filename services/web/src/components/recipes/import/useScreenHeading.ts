import { useEffect, useRef } from "react";

/**
 * Move focus to a screen's heading when that screen mounts (plan §10.4, binding).
 *
 * `drop → reading → review → committing → done` swaps the entire main region five times.
 * Without this, focus stays on whatever control triggered the swap — a button that no
 * longer exists — and a keyboard or screen-reader user is dropped at the top of the
 * document with no announcement of what just happened.
 *
 * The heading takes `tabIndex={-1}` so it is programmatically focusable but never lands in
 * the tab order, and `focus({ preventScroll: true })` so the page does not jump under a
 * sighted mouse user who caused the same transition.
 */
export function useScreenHeading<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}
