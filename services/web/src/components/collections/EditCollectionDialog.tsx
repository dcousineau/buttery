import { type FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, UtensilsCrossed, X } from "lucide-react";
import { type CollectionSummary, type HouseholdRecipeRow, removeRecipeFromCollectionMutation, updateCollectionMutation } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { AddRecipesSheet } from "./AddRecipesSheet";

/**
 * Edit one collection: its name, its description, and what is on it (§7).
 *
 * **Two shells, one form.** §7's component table asks for a dialog on the
 * desktop and a *full-height sheet* below `md`, and this file is where that
 * split lives. Both shells are the same Base UI `Dialog` primitive underneath
 * (`ui/sheet.tsx` re-skins it), so `DialogTitle`, `DialogClose` and friends work
 * inside either root — the form below is byte-identical in both and never asks
 * which one it is in, except to decide whether to offer the mobile "Add
 * recipes" sheet.
 *
 * The shell is chosen with `useIsMobile()` rather than CSS, following
 * `ThisWeekPanel`: rendering both and hiding one would mount two modals, two
 * focus traps and two copies of every field id. It is the one place in this
 * feature where a media query has to be a JS one.
 *
 * Membership: **removal** in the list below, and **addition** through
 * `AddRecipesSheet` on mobile only. The desktop adds from the recipe side (the
 * picker) or, from milestone 3, by dragging a ledger card onto the row —
 * neither of which a phone has, which is exactly why §7 puts an "Add recipes"
 * sheet in the mobile column and not in the desktop one.
 *
 * Both writes are the port's optimistic mutations, so the tree's counts and the
 * scoped ledger behind the dialog move on the same frame as the click.
 *
 * NOT here yet, by milestone:
 *
 * - **TODO(m3)** — drag-to-reorder the member list. The rows below are already a
 *   single flex line per entry with the grip's slot free at the leading edge and
 *   the order they render in IS `recipeIds`, which is the published array order.
 * - **TODO(m5)** — the owner-only publish section: "Published by @handle", the
 *   stale badge and its retry, unpublish, and delete. It mounts under the member
 *   list, above the footer. Delete is owner-only server-side, so M5 gates the
 *   affordance on the caller's role rather than letting a member discover it by
 *   failure.
 */
export function EditCollectionDialog({
  householdId,
  collection,
  recipes,
  onOpenChange,
}: {
  householdId: string;
  /** `null` closes the dialog — the tree holds "which collection" as the open state. */
  collection: CollectionSummary | null;
  recipes: HouseholdRecipeRow[];
  onOpenChange: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const open = collection != null;

  const form = collection && (
    // Keyed by id so opening a different collection remounts the form
    // rather than leaving the previous one's draft in the fields.
    <EditCollectionForm key={collection.id} householdId={householdId} collection={collection} recipes={recipes} mobile={isMobile} onClose={() => onOpenChange(false)} />
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        {/*
          Full height, not `h-auto`: §7 asks for a full-height sheet, and a
          shelf's member list is the one part of this form that can be thirty
          rows long. The `data-[side=bottom]:` modifier is repeated so the
          height actually replaces the primitive's own attribute-selector rule.
        */}
        <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0 data-[side=bottom]:h-svh">
          {form}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `overflow-hidden` + a max height: the form owns its own scroll region,
        so the header and the footer stay put while the member list moves. */}
      <DialogContent size="lg" className="max-h-[85vh] gap-0 overflow-hidden p-0">
        {form}
      </DialogContent>
    </Dialog>
  );
}

function EditCollectionForm({
  householdId,
  collection,
  recipes,
  mobile,
  onClose,
}: {
  householdId: string;
  collection: CollectionSummary;
  recipes: HouseholdRecipeRow[];
  /** True in the sheet shell — the only thing the form does differently. */
  mobile: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const [addOpen, setAddOpen] = useState(false);

  const update = useMutation(updateCollectionMutation(queryClient, householdId));
  const unfile = useMutation(removeRecipeFromCollectionMutation(queryClient, householdId));

  const byId = new Map(recipes.map((row) => [row.recipeId, row]));
  // Entry order, which is the order the published `recipes` array carries.
  // A member the box no longer holds is dropped rather than rendered as a hole:
  // the server unfiles it on box removal (§2.11), so this is only ever a cache
  // that has not caught up.
  const members = collection.recipeIds.map((recipeId) => byId.get(recipeId)).filter((row): row is HouseholdRecipeRow => row != null);

  const trimmed = name.trim();
  const nextDescription = description.trim();
  const dirty = trimmed !== collection.name || nextDescription !== (collection.description ?? "");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // A blank name is not a rename, it is a slip: the server refuses it and a
    // nameless row is unreadable in the tree.
    if (!trimmed) return;
    if (dirty) update.mutate({ collectionId: collection.id, name: trimmed, description: nextDescription === "" ? null : nextDescription });
    onClose();
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
      <header className="flex flex-none items-start gap-2 border-b-2 border-border px-5 py-4 md:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>Edit collection</DialogTitle>
          <DialogDescription>Rename the shelf, say what belongs on it, and take anything off that doesn’t.</DialogDescription>
        </div>
        {/* The sheet has no chrome of its own (`showCloseButton={false}`), and a
          full-height sheet with only a footer Cancel is a sheet people swipe at.
          44px, like everything else on the mobile surface. */}
        {mobile && (
          <DialogClose render={<Button type="button" variant="ghost" size="icon" className="-mt-1 -mr-1.5 size-11 shrink-0" onClick={onClose} />}>
            <X aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogClose>
        )}
      </header>

      {/* The one scrolling region. Everything above and below it is pinned, so a
        long shelf never pushes the Save button off a phone screen. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4 md:px-6">
        <Field>
          <FieldLabel htmlFor="collection-name">Name</FieldLabel>
          <Input id="collection-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Weeknights" />
        </Field>

        <Field>
          <FieldLabel htmlFor="collection-description">Description</FieldLabel>
          <Textarea
            id="collection-description"
            rows={2}
            value={description}
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional — what makes something belong here."
          />
        </Field>

        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">
              On this shelf
              <span className="ml-1.5 tabular-nums">{members.length}</span>
            </h3>
            {mobile && (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={!online}
                title={online ? undefined : OFFLINE_WRITE_HINT}
                aria-haspopup="dialog"
                aria-expanded={addOpen}
                onClick={() => setAddOpen(true)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add recipes
              </Button>
            )}
          </div>

          {members.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-lg border-2 border-dashed border-border/60 px-6 py-8 text-center">
              <UtensilsCrossed className="size-7 text-muted-foreground" aria-hidden="true" />
              <p className="m-0 text-xs text-pretty text-muted-foreground">
                {mobile
                  ? "Nothing filed here yet. “Add recipes” picks them straight out of your box."
                  : "Nothing filed here yet. Open a recipe and add it from its collections row."}
              </p>
            </div>
          ) : (
            // On mobile the whole form scrolls as one column, so a second
            // scroller inside it would be a trap for a thumb. The desktop keeps
            // its capped, independently-scrolling list.
            <ul className={`m-0 flex list-none flex-col p-0 ${mobile ? "" : "max-h-[14rem] overflow-auto"}`}>
              {members.map((row) => (
                // TODO(m3): the drag handle mounts at this row's leading edge and
                // `reorderCollectionRecipesMutation` takes the resulting order.
                <li key={row.recipeId} className="flex items-center gap-2 border-b-2 border-border/45 py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground">{row.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    // 44px on a phone, where this is the only way off a shelf;
                    // the desktop keeps the quiet 24px row action.
                    size={mobile ? "icon" : "icon-xs"}
                    className={mobile ? "size-11 text-muted-foreground" : "text-muted-foreground"}
                    disabled={!online}
                    title={online ? undefined : OFFLINE_WRITE_HINT}
                    aria-label={`Take ${row.title} off ${collection.name}`}
                    onClick={() => unfile.mutate({ collectionId: collection.id, recipeId: row.recipeId })}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <DialogFooter className="mt-0 flex-none border-t-2 border-border px-5 py-3.5 md:px-6">
        <DialogClose render={<Button type="button" variant="ghost" className={mobile ? "h-11 flex-1" : undefined} onClick={onClose} />}>Cancel</DialogClose>
        <Button type="submit" className={mobile ? "h-11 flex-1" : undefined} disabled={!trimmed || !online} title={online ? undefined : OFFLINE_WRITE_HINT}>
          Save collection
        </Button>
      </DialogFooter>

      {/* Mobile only, and nested inside this sheet on purpose: closing the edit
        sheet to file recipes would drop the name and description someone was
        halfway through typing. */}
      {mobile && <AddRecipesSheet open={addOpen} onOpenChange={setAddOpen} collection={collection} recipes={recipes} householdId={householdId} />}
    </form>
  );
}
