import { useCallback } from "react";
import { Bookmark } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "#/components/ui/dialog";
import { Button } from "#/components/ui/button";

/**
 * The "Get the bookmarklet" install dialog (plan §C2). A drag-to-bookmarks-bar
 * card: the "Save to Buttery" button's href IS the `javascript:` bookmarklet,
 * which just injects our served loader (`/bookmarklet.js`) as a <script>. The
 * user drags it to their bookmarks bar; on a hostile recipe page, clicking it
 * ships the page's JSON-LD/HTML to the authenticated bridge tab.
 *
 * Chrome names a dragged <a> bookmark from its link TEXT and its url from href —
 * so "Save to Buttery" + the bookmarklet href gives a correctly-named bookmark.
 * BUT React sanitizes any `javascript:` href at render time (it swaps in a
 * throwing stub), which would make the dragged bookmark a dead link. So we set
 * the real href IMPERATIVELY on mount via a ref callback (setAttribute bypasses
 * React's sanitizer), building it from the live origin (dev 127.0.0.1 vs prod).
 */
export function BookmarkletInstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // Ref callback: when the anchor mounts, stamp the real bookmarklet href on it
  // directly. The tiny loader-injector is kept minimal — all real logic lives in
  // the served bundle so it can be fixed without re-dragging the bookmarklet.
  const setAnchorHref = useCallback((node: HTMLAnchorElement | null) => {
    if (!node) return;
    const origin = window.location.origin;
    const href = `javascript:(function(){var s=document.createElement('script');s.src='${origin}/bookmarklet.js?v='+Date.now();document.body.appendChild(s);})();`;
    node.setAttribute("href", href);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogTitle>Get the bookmarklet</DialogTitle>
        <DialogDescription>
          Click and drag this to your bookmarks bar. It doesn't install and it isn't a link to click here — click and drag it onto your bookmarks bar.
        </DialogDescription>

        <div className="mt-3 flex justify-center rounded-lg border-2 border-dashed border-border bg-card p-4">
          {/* href is set imperatively (ref) to dodge React's javascript:-URL
              sanitizer. No onDragStart override — the native anchor drag carries
              the link text as the bookmark name; overriding it drops the title.
              a11y rules disabled: this is a drag target (drag to bookmarks bar),
              not a navigable link or a button — there is no keyboard/click action. */}
          {/* eslint-disable-next-line jsx-a11y/anchor-is-valid, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <a
            ref={setAnchorHref}
            onClick={(e) => e.preventDefault()}
            className="inline-flex cursor-grab items-center gap-2 rounded-md border-2 border-border bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground shadow-(--shadow-pop-sm) active:cursor-grabbing"
          >
            <Bookmark className="size-4" aria-hidden="true" />
            Save to Buttery
          </a>
        </div>

        <ol className="mt-3 flex flex-col gap-1.5 pl-5 text-[0.8125rem] text-muted-foreground">
          <li>Show your bookmarks bar.</li>
          <li>Click and drag the button above onto it — don't just click it.</li>
          <li>On a recipe page, click Save to Buttery — you stay signed in.</li>
        </ol>

        <DialogFooter className="mt-4">
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
