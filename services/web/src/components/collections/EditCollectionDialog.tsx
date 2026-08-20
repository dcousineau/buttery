import { type FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UtensilsCrossed, X } from "lucide-react";
import { type CollectionSummary, type HouseholdRecipeRow, removeRecipeFromCollectionMutation, updateCollectionMutation } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";

/**
 * Edit one collection: its name, its description, and what is on it (§7).
 *
 * Membership is edited here as *removal only*. Adding happens where the recipe
 * is — the picker on a recipe's detail — because "which shelves does this recipe
 * belong on?" is the question people actually have, and a second recipe-picker
 * inside this dialog would be a fourth place to answer it.
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
  return (
    <Dialog open={collection != null} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-auto">
        {collection && (
          // Keyed by id so opening a different collection remounts the form
          // rather than leaving the previous one's draft in the fields.
          <EditCollectionForm key={collection.id} householdId={householdId} collection={collection} recipes={recipes} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditCollectionForm({
  householdId,
  collection,
  recipes,
  onClose,
}: {
  householdId: string;
  collection: CollectionSummary;
  recipes: HouseholdRecipeRow[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const online = useIsOnline();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");

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
    <form className="flex min-h-0 flex-col gap-4" onSubmit={onSubmit}>
      <div className="flex flex-col gap-1">
        <DialogTitle>Edit collection</DialogTitle>
        <DialogDescription>Rename the shelf, say what belongs on it, and take anything off that doesn’t.</DialogDescription>
      </div>

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
        <h3 className="m-0 text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">
          On this shelf
          <span className="ml-1.5 tabular-nums">{members.length}</span>
        </h3>

        {members.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-lg border-2 border-dashed border-border/60 px-6 py-8 text-center">
            <UtensilsCrossed className="size-7 text-muted-foreground" aria-hidden="true" />
            <p className="m-0 text-xs text-muted-foreground">Nothing filed here yet. Open a recipe and add it from its collections row.</p>
          </div>
        ) : (
          <ul className="m-0 flex max-h-[14rem] list-none flex-col overflow-auto p-0">
            {members.map((row) => (
              // TODO(m3): the drag handle mounts at this row's leading edge and
              // `reorderCollectionRecipesMutation` takes the resulting order.
              <li key={row.recipeId} className="flex items-center gap-2 border-b-2 border-border/45 py-1.5 last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground">{row.title}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
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

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" onClick={onClose} />}>Cancel</DialogClose>
        <Button type="submit" disabled={!trimmed || !online} title={online ? undefined : OFFLINE_WRITE_HINT}>
          Save collection
        </Button>
      </DialogFooter>
    </form>
  );
}
