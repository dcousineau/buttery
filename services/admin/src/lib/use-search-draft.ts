import { useEffect, useRef, useState } from "react";

/**
 * A text input whose committed value lives in the URL.
 *
 * Every list view in the admin keeps its table state in search params — page,
 * sort, filters, and the search box — because that makes a filtered view a link
 * an operator can paste into a ticket, and makes the query key trivially
 * correct. A search box cannot write straight to the URL, though: that is a
 * history entry and a database query per keystroke. So the draft is local and
 * debounced into the URL.
 *
 * Two things this gets right that the obvious version does not:
 *
 * 1. **The URL can change underneath the box** — the back button, a link that
 *    sets `?q=`, a "clear filters" action. The draft has to follow. Doing that
 *    with an effect (`useEffect(() => setDraft(committed), [committed])`) is
 *    the classic cascading-render bug React Compiler flags: it renders once with
 *    the stale draft, then again with the new one. Adjusting state *during*
 *    render is React's documented answer, and it re-renders before anything is
 *    committed to the DOM.
 *
 * 2. **The commit callback is held in a ref.** Call sites pass an inline arrow,
 *    so its identity changes on every render — including renders caused by a
 *    query settling. In the dependency array it would re-arm the timer each
 *    time and the commit could be postponed indefinitely while data loads.
 */
export function useSearchDraft(committed: string, commit: (next: string) => void, delayMs = 300): readonly [string, (next: string) => void] {
  const [draft, setDraft] = useState(committed);
  const [synced, setSynced] = useState(committed);

  // Adjust-during-render, not an effect. See (1) above.
  if (synced !== committed) {
    setSynced(committed);
    setDraft(committed);
  }

  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  useEffect(() => {
    // Already in sync — nothing to debounce. Also the state right after the URL
    // catches up, which is what stops the commit from firing a second time.
    if (draft === committed) return;
    const timer = setTimeout(() => commitRef.current(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft, committed, delayMs]);

  return [draft, setDraft] as const;
}
