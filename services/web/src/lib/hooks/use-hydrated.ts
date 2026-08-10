import { useSyncExternalStore } from "react";

/** No store to subscribe to — the value flips once, when React hydrates. */
const noopSubscribe = () => () => {};

/**
 * False on the server AND on the client's hydration render; true from the first
 * commit after that.
 *
 * For anything whose value is only knowable in the browser — a persisted
 * session, `localStorage`, `window.matchMedia` — this is what keeps the first
 * client render byte-identical to the SSR output. React does not patch a
 * hydration mismatch; it throws away the whole subtree and re-renders it, and
 * logs an error while doing so. In dev that error is worse than it sounds: the
 * devtools console pipe echoes it between client and server, so one mismatch on
 * every page load is a steadily growing log line and, eventually, an
 * out-of-memory dev server.
 *
 * `useSyncExternalStore` rather than the `useState` + `useEffect` idiom because
 * it is the version React itself sanctions for this: `getServerSnapshot`
 * answers the SSR and hydration passes, `getSnapshot` every render after.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
