import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the desktop collections column is showing — persisted in a cookie,
 * the same idiom the app sidebar uses for its own rail (`ui/sidebar.tsx`).
 *
 * A cookie rather than `localStorage` because the value is layout, and layout
 * has to be knowable on the server the day this column is rendered during SSR
 * without a flash. Nothing reads it server-side *yet* (the sidebar's doesn't
 * either), but picking the storage that can be read there is free now and a
 * rewrite later.
 *
 * **Collapsed by default** (collections plan §7). Collections are a power tool
 * over a box someone might not have organised at all; the ledger is the page.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, for the reason the
 * repo already uses it in `use-mobile.ts`: it takes a *server* snapshot, so the
 * hydration pass renders the collapsed default and the real cookie value lands
 * on the first client render after it — no mismatch warning, no `setState` in an
 * effect, and no frame of the wrong layout.
 */

const COOKIE_NAME = "collections_column";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * The document's cookie has no change event, and the only writer is `setOpen`
 * below — so the store is a plain listener set that the setter pokes. Two
 * columns mounted at once (desktop column and, from milestone 4, a sheet) then
 * stay in step without either of them owning the state.
 */
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function readCookie(): boolean {
  return document.cookie.split("; ").includes(`${COOKIE_NAME}=true`);
}

export function useCollectionsColumn(): { open: boolean; setOpen: (open: boolean) => void; toggle: () => void } {
  const open = useSyncExternalStore(subscribe, readCookie, () => false);

  const setOpen = useCallback((next: boolean) => {
    document.cookie = `${COOKIE_NAME}=${next}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
    for (const listener of listeners) listener();
  }, []);

  const toggle = useCallback(() => setOpen(!readCookie()), [setOpen]);

  return { open, setOpen, toggle };
}
