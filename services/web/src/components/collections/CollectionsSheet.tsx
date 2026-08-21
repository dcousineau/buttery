import { useState } from "react";
import { FolderLock, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "#/components/ui/sheet";
import { cn } from "#/lib/utils";
import { CollectionsTree } from "./CollectionsTree";
import { type LedgerScope, scopeLabel } from "./scope";

/**
 * The `<md` collections tree (§7) — and, because a phone has room for one
 * column, the recipes page's only way to reach it.
 *
 * **It is a wrapper, not a second tree.** `CollectionsTree` reads its own two
 * cached queries, resolves the active scope from the URL and owns the edit
 * dialog, so mounting it in a `Sheet` and handing it `onNavigate` is the entire
 * mobile port of the desktop column — milestone 2 built it that way on purpose,
 * and this milestone did not have to touch it. Everything the tree can do on a
 * desktop (pick a smart row, pick a collection, quick-add a new one, open the edit
 * surface) it does here, unchanged.
 *
 * The trigger renders the **active scope's name** rather than the word
 * "Collections". The desktop has a whole column standing there saying what the
 * ledger is showing; a phone has one strip, so it has to do both jobs — "you
 * are looking at Weeknights, tap to look at something else". `scopeLabel` is
 * the same function the scoped ledger header uses, so the two can never
 * disagree.
 *
 * `onNavigate` closes the sheet behind a tap: picking a collection is navigation, and
 * a panel that stayed open over the list it just changed would hide the answer.
 */
/**
 * Milestone 4 shipped a `TOUCH_TREE` override here — a stack of
 * arbitrary-variant classes that grew the tree's 30px rows to 44px and revealed
 * its hover-only gear, applied from *outside* because that milestone did not own
 * `CollectionRow.tsx`. Those rules now live on the elements they describe, under
 * a `pointer-coarse:` variant, so a touchscreen gets them wherever the tree is
 * mounted and a mouse never does. The sheet has no styling opinion left beyond
 * filling its own height.
 */

export function CollectionsSheet({ householdId, scope, className }: { householdId: string; scope: LedgerScope; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    // The strip matches the ledger's filter bar directly below it — same card
    // fill, same 2px rule — so the two read as one head rather than a control
    // floating above a toolbar.
    <div className={cn("flex flex-none items-center border-b-2 border-border bg-card px-2.5 py-2", className)}>
      <Button
        variant="outline"
        // 44px: the smallest touch target this feature ships (§7).
        className="h-11 min-w-0 flex-1 justify-start"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <FolderLock data-icon="inline-start" aria-hidden="true" />
        <span className="min-w-0 truncate">{scopeLabel(scope)}</span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        {/*
          The width override repeats the `data-[side=left]:` modifier so it
          actually replaces the base rule — an unmodified `w-…` loses to the
          attribute selector (the same trap `ThisWeekPanel` documents).
          `p-0`/`gap-0` because the tree ships its own header rule and padding.
        */}
        <SheetContent side="left" showCloseButton={false} className="gap-0 p-0 data-[side=left]:w-[min(18rem,86vw)]">
          {/* The tree renders a visible "Collections" heading of its own; this
            is the accessible name of the *dialog*, which a heading inside it
            cannot supply. */}
          <SheetTitle className="sr-only">Collections</SheetTitle>
          <SheetDescription className="sr-only">Pick a smart list or a collection to scope your recipe box. Picking one closes this panel.</SheetDescription>

          {/* The primitive's own close is a 28px icon button. This one is 44px,
            like every other target in the mobile surface. */}
          <SheetClose render={<Button variant="ghost" size="icon" className="absolute top-0.5 right-0.5 z-10 size-11" />}>
            <X aria-hidden="true" />
            <span className="sr-only">Close collections</span>
          </SheetClose>

          <CollectionsTree householdId={householdId} onNavigate={() => setOpen(false)} className="h-full" />
        </SheetContent>
      </Sheet>
    </div>
  );
}
