import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, EyeOff, Globe, Plus, RefreshCw, Trash2, UtensilsCrossed, X } from "lucide-react";
import {
  type CollectionSummary,
  deleteCollection,
  householdCollectionsQuery,
  type HouseholdRecipeRow,
  keys,
  myHouseholdsQuery,
  publishCollection,
  removeRecipeFromCollectionMutation,
  reorderCollectionRecipesMutation,
  reorderCollectionsMutation,
  unpublishCollection,
  updateCollectionMutation,
} from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { useIsMobile } from "#/lib/hooks/use-mobile";
import { useSessionSnapshot } from "#/lib/offline/use-household";
import { applyVisibleOrder, moveByKey, type ReorderMove } from "#/lib/reorder";
import { useRecipesView } from "#/components/recipes/context";
import { AtprotoReauthDialog } from "#/components/AtprotoReauthDialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Sheet, SheetContent } from "#/components/ui/sheet";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { AddRecipesSheet } from "./AddRecipesSheet";
import { DeleteCollectionDialog } from "./DeleteCollectionDialog";
import { PublishConfirmDialog } from "./PublishConfirmDialog";
import { UnpublishConfirmDialog } from "./UnpublishConfirmDialog";
import { publisherName, useStaleToast } from "./use-stale-toast";

/**
 * Edit one collection: its name, its description, what is on it and in what
 * order, and — for an owner — whether it exists on the atproto network at all
 * (§7).
 *
 * **Two shells, one form.** §7's component table asks for a dialog on the
 * desktop and a *full-height sheet* below `md`, and this file is where that
 * split lives. Both shells are the same Base UI `Dialog` primitive underneath
 * (`ui/sheet.tsx` re-skins it), so `DialogTitle`, `DialogClose` and friends work
 * inside either root — the form below is byte-identical in both and never asks
 * which one it is in, except to decide whether to offer the mobile "Add
 * recipes" sheet and how big to draw a touch target.
 *
 * The shell is chosen with `useIsMobile()` rather than CSS, following
 * `ThisWeekPanel`: rendering both and hiding one would mount two modals, two
 * focus traps and two copies of every field id. It is the one place in this
 * feature where a media query has to be a JS one.
 *
 * Membership: **removal and ordering** in the list below, and **addition**
 * through `AddRecipesSheet` on mobile only. The desktop adds from the recipe
 * side (the picker) or by dragging a ledger card onto the row — neither of which
 * a phone has, which is exactly why §7 puts an "Add recipes" sheet in the mobile
 * column and not in the desktop one.
 *
 * Every write here is the port's optimistic mutation, so the tree's counts and
 * the scoped ledger behind the dialog move on the same frame as the click — and
 * every one of them can come back `stale`, meaning the local rows saved but the
 * publisher's copy is behind. That is a notice with a retry, never a failure:
 * see `use-stale-toast.ts`.
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
          collection's member list is the one part of this form that can be thirty
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
  /** What the last move did — either kind — for people who cannot see rows move. */
  const [moved, setMoved] = useState("");

  /**
   * Every collection the household has, in the order the tree draws them. It is
   * the same cached entry the tree read to render the row this dialog was opened
   * from, so it is primed by construction and this never suspends — and the
   * reorder below patches it optimistically, so the position shown here moves on
   * the same frame as the click.
   */
  const { data: siblings } = useSuspenseQuery(householdCollectionsQuery(householdId));

  const { notifyStale } = useStaleToast(householdId);

  /**
   * `stale` is handled in each mutation's **own** options rather than in a
   * per-call `onSuccess`, because saving closes this dialog: query-core skips a
   * `mutate(vars, { onSuccess })` callback when the observer has no listeners
   * left (the component unmounted), and drops the notice with it. Options-level
   * callbacks run on the mutation itself and survive the unmount, which is
   * exactly what a message about a write that outlived its dialog needs.
   */
  const onStale = (result: { stale: boolean }) => {
    if (result.stale) notifyStale(collection);
  };
  const update = useMutation({ ...updateCollectionMutation(queryClient, householdId), onSuccess: onStale });
  const unfile = useMutation({ ...removeRecipeFromCollectionMutation(queryClient, householdId), onSuccess: onStale });
  const reorder = useMutation({ ...reorderCollectionRecipesMutation(queryClient, householdId), onSuccess: onStale });
  // No `onStale` on this one, and that is not an oversight: the household's list
  // order is local-only and has no published copy to fall behind (§2.10).
  const reorderList = useMutation(reorderCollectionsMutation(queryClient, householdId));

  const byId = new Map(recipes.map((row) => [row.recipeId, row]));
  // Entry order, which is the order the published `recipes` array carries.
  // A member the box no longer holds is dropped rather than rendered as a hole:
  // the server unfiles it on box removal (§2.11), so this is only ever a cache
  // that has not caught up.
  const members = collection.recipeIds.map((recipeId) => byId.get(recipeId)).filter((row): row is HouseholdRecipeRow => row != null);
  const visibleIds = members.map((row) => row.recipeId);

  // Where this collection sits among the household's collections. `-1` means a
  // cache that has not caught up (it was deleted elsewhere) — no position to
  // show and nothing to move.
  const siblingIds = siblings.map((row) => row.id);
  const position = siblingIds.indexOf(collection.id);

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

  /**
   * Move one member a place up or down — the **pointer-only path** to a
   * reordering that otherwise only a drag or an arrow key could do (WCAG 2.5.7,
   * the gap milestone 3 flagged and left here).
   *
   * It writes the collection's **full** entry order, not the rendered one: a
   * member the box no longer holds is not rendered above, and `applyVisibleOrder`
   * puts those absent ids back in their own slots rather than dropping them
   * (`lib/reorder.ts` — the same guard the scoped ledger's drag goes through).
   */
  function move(index: number, direction: ReorderMove) {
    const nextVisible = moveByKey(visibleIds, index, direction);
    // `moveByKey` hands back the same array when the move would fall off an end.
    if (nextVisible === visibleIds) return;
    reorder.mutate({ collectionId: collection.id, orderedRecipeIds: applyVisibleOrder(collection.recipeIds, nextVisible) });
    setMoved(`${members[index].title} moved to ${nextVisible.indexOf(visibleIds[index]) + 1} of ${nextVisible.length}.`);
  }

  /**
   * Move **this collection** a place up or down the household's list.
   *
   * Not to be confused with `move` above: that one reorders a *recipe inside*
   * this collection, this one reorders the collection itself among its siblings.
   * The label and the announcement both say "in your collections" so the two can
   * never be read as the same control.
   *
   * The tree renders every collection the household has, so `siblingIds` is
   * already the whole order — no `applyVisibleOrder` fold is needed here, unlike
   * the member list, which renders a subset.
   */
  function moveCollection(direction: ReorderMove) {
    const nextIds = moveByKey(siblingIds, position, direction);
    // `moveByKey` hands back the same array when the move would fall off an end.
    if (nextIds === siblingIds) return;
    reorderList.mutate({ orderedIds: nextIds });
    setMoved(`${collection.name} moved to ${nextIds.indexOf(collection.id) + 1} of ${nextIds.length} in your collections.`);
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
      <header className="flex flex-none items-start gap-2 border-b-2 border-border px-5 py-4 md:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>Edit collection</DialogTitle>
          <DialogDescription>Rename the collection, say what belongs in it, and take anything off that doesn’t.</DialogDescription>
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
        long collection never pushes the Save button off a phone screen — and the
        publishing card at the foot of it scrolls with the rest. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4 md:px-6">
        <Field>
          <FieldLabel htmlFor="collection-name">Name</FieldLabel>
          <Input id="collection-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Weeknights" />
        </Field>

        {/* The collection's own place in the household's list. It sits here,
          beside the name, because it is a fact about *this collection* — where
          it is filed — and not about what is filed in it; putting it down beside
          the member list would park it two rows from a second pair of up/down
          buttons that mean something else entirely.

          It is also the only pointer-and-keyboard path to that order now that
          the tree's rows carry no drag grip. Hidden outright when there is
          nothing to move past: a lone collection reading "1 of 1" over two dead
          buttons is noise. */}
        {position >= 0 && siblingIds.length > 1 && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle id="collection-position">Position in your collections</FieldTitle>
              <FieldDescription className="tabular-nums">
                {position + 1} of {siblingIds.length}
              </FieldDescription>
            </FieldContent>
            <div className="flex flex-none items-center gap-1.5" role="group" aria-labelledby="collection-position">
              <Button
                type="button"
                variant="outline"
                // 44px on the sheet, like every other control on that surface.
                size={mobile ? "icon" : "icon-sm"}
                className={mobile ? "size-11" : undefined}
                disabled={!online || position === 0}
                title={online ? undefined : OFFLINE_WRITE_HINT}
                aria-label={`Move ${collection.name} up in your collections`}
                onClick={() => moveCollection("up")}
              >
                <ChevronUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size={mobile ? "icon" : "icon-sm"}
                className={mobile ? "size-11" : undefined}
                disabled={!online || position === siblingIds.length - 1}
                title={online ? undefined : OFFLINE_WRITE_HINT}
                aria-label={`Move ${collection.name} down in your collections`}
                onClick={() => moveCollection("down")}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </div>
          </Field>
        )}

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

        {/* `shrink-0`, not `min-h-0`: on mobile this list has no scroller of
          its own (a second one inside the form would trap a thumb), so if it
          were allowed to shrink it would hand its space to the publishing card
          and spill its last rows underneath it instead of scrolling the form. */}
        <div className="flex shrink-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-[0.6875rem] font-bold tracking-[0.06em] text-muted-foreground uppercase">
              In this collection
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
              {members.map((row, index) => (
                <li key={row.recipeId} className="flex items-center gap-2 border-b-2 border-border/45 py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-foreground">{row.title}</span>
                  {/* The order of this list IS the published `recipes` array
                    order (§2.6), and until now the only ways to change it were a
                    drag and the arrow keys on a grip. These two buttons are the
                    pointer-only path WCAG 2.5.7 requires — and, on a phone,
                    the only path at all: there is no drag below `md` (§7). */}
                  {members.length > 1 && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size={mobile ? "icon" : "icon-xs"}
                        className={mobile ? "size-11 text-muted-foreground" : "text-muted-foreground"}
                        disabled={!online || index === 0}
                        title={online ? undefined : OFFLINE_WRITE_HINT}
                        aria-label={`Move ${row.title} up`}
                        onClick={() => move(index, "up")}
                      >
                        <ChevronUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size={mobile ? "icon" : "icon-xs"}
                        className={mobile ? "size-11 text-muted-foreground" : "text-muted-foreground"}
                        disabled={!online || index === members.length - 1}
                        title={online ? undefined : OFFLINE_WRITE_HINT}
                        aria-label={`Move ${row.title} down`}
                        onClick={() => move(index, "down")}
                      >
                        <ChevronDown aria-hidden="true" />
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    // 44px on a phone, where this is the only way out of a collection;
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

        {/* A move is invisible to anyone not watching the rows move. One region
          for both kinds — the collection's own position and the order of what is
          filed in it — because two polite regions racing each other announce
          less, not more; each message names what moved and which list it moved
          in, so they can't be mistaken for one another. */}
        <p className="sr-only" role="status" aria-live="polite">
          {moved}
        </p>

        <PublishSection householdId={householdId} collection={collection} recipes={recipes} mobile={mobile} online={online} onDeleted={onClose} />
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

/**
 * The publishing card (§7) — whether this collection exists on the atproto
 * network, and the three writes that change that answer.
 *
 * It is a `Card` rather than a run of loose rows under a rule because it is one
 * concern with one question at the top of it, and the kit already has a
 * container that says so. The card's own border replaces the separator this
 * section used to carry; keeping both would draw the same line twice.
 *
 * **Who sees what.** Publishing, unpublishing and deleting are owner-only
 * server-side (`assertMember(…, "owner")`, §2.8), so a member is shown the
 * *state* — "Published by @sam", or that the collection is household-only — and none
 * of the buttons, rather than discovering the rule by pressing one. The retry
 * beside a stale badge is the deliberate exception: `retryCollectionSync` is
 * member-level, because the person looking at "your change didn't reach the
 * published copy" is whoever just made the change.
 *
 * **Every refusal resolves.** None of these three calls throws for a decision
 * (§5's contract), so there is no `catch` doing the talking: the dialogs stay
 * open holding the reason, and only `scope_error` navigates anywhere — to the
 * shared re-authorize prompt, because an under-scoped grant is the one failure
 * the person reading it can fix.
 *
 * Deleting is the only one that can leave nothing to come back to, and the
 * server orders it so a PDS failure means **nothing was deleted anywhere** —
 * which is what the dialog says.
 */
function PublishSection({
  householdId,
  collection,
  recipes,
  mobile,
  online,
  onDeleted,
}: {
  householdId: string;
  collection: CollectionSummary;
  recipes: HouseholdRecipeRow[];
  mobile: boolean;
  online: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/household/recipes" });
  const { pushToast } = useRecipesView();
  const { retrySync } = useStaleToast(householdId);
  // Role is the only thing this read is for; it decides what to draw, never what
  // is allowed. `undefined` while it is in flight, so the owner controls appear
  // when the answer does rather than flashing and being taken away.
  const { data: households } = useQuery(myHouseholdsQuery());
  const isOwner = households?.find((row) => row.id === householdId)?.role === "owner";
  const myHandle = useSessionSnapshot()?.handle ?? null;

  const [publishOpen, setPublishOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Ids from a `recipes_unpublished` preflight — the collection's own private members. */
  const [blockedIds, setBlockedIds] = useState<string[]>([]);

  const published = collection.publishedAt != null;
  const publisher = publisherName(collection.publishedByHandle);
  const blockedTitles = recipes.filter((row) => blockedIds.includes(row.recipeId)).map((row) => row.title);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: keys.household.collections(householdId) });
  }

  /** The one failure sentence a PDS refusal gets, in the voice of whose PDS it is. */
  function pdsFailure(handle: string | null, what: string) {
    return `We couldn’t reach ${publisherName(handle)}’s PDS. ${what}`;
  }

  async function onPublish() {
    setPending(true);
    setFailure(null);
    setBlockedIds([]);
    try {
      const result = await publishCollection(collection.id);
      await refresh();
      if (result.ok) {
        setPublishOpen(false);
        pushToast(`Published as ${publisherName(result.publishedByHandle ?? myHandle)}`);
        return;
      }
      if (result.reason === "recipes_unpublished") {
        setBlockedIds(result.recipeIds);
        return;
      }
      if (result.reason === "scope_error") {
        setPublishOpen(false);
        setReauthOpen(true);
        return;
      }
      if (result.reason === "flag_disabled") {
        setFailure("Publishing is switched off right now. Nothing was published.");
        return;
      }
      setFailure(pdsFailure(result.handle ?? myHandle, "Nothing was published — try again in a bit."));
    } catch {
      setFailure("That didn’t publish. Nothing changed — try again.");
    } finally {
      setPending(false);
    }
  }

  async function onUnpublish() {
    setPending(true);
    setFailure(null);
    try {
      const result = await unpublishCollection(collection.id);
      await refresh();
      if (result.ok) {
        setUnpublishOpen(false);
        pushToast(result.unpublished ? `Unpublished — the record is gone from ${publisher}’s PDS` : "That collection wasn’t published");
        return;
      }
      if (result.reason === "scope_error") {
        setUnpublishOpen(false);
        setReauthOpen(true);
        return;
      }
      setFailure(pdsFailure(result.handle ?? collection.publishedByHandle, "Nothing changed — the record is still published."));
    } catch {
      setFailure("That didn’t unpublish. Nothing changed — try again.");
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteCollection(collection.id);
      await refresh();
      if (result.ok) {
        setDeleteOpen(false);
        pushToast(`Deleted ${collection.name}`);
        // The collection that was on screen is gone; leaving `?c=<id>` in the URL
        // would answer the click with "this collection no longer exists".
        if (search.c === collection.id) await navigate({ to: "/household/recipes", search: {} });
        onDeleted();
        return;
      }
      if (result.reason === "scope_error") {
        setDeleteOpen(false);
        setReauthOpen(true);
        return;
      }
      // The PDS delete runs first and the local rows go only if it succeeded, so
      // this really does mean nothing was deleted — say so rather than leaving
      // someone wondering which half went.
      setFailure(pdsFailure(result.handle ?? collection.publishedByHandle, "Nothing was deleted — the collection and its published record are both still here."));
    } catch {
      setFailure("That didn’t delete. Nothing changed — try again.");
    } finally {
      setPending(false);
    }
  }

  async function onRetrySync() {
    setRetrying(true);
    try {
      await retrySync(collection);
    } finally {
      setRetrying(false);
    }
  }

  const touchButton = mobile ? "h-11" : undefined;
  /** Shown to members as well as owners — see the note on the strip below. */
  const stale = published && collection.recordStale;

  return (
    <>
      {/* `flex-none`: the card clips its own overflow, and an `overflow-hidden`
        child of a scrolling flex column loses its automatic minimum size — which
        is a licence for the column to squash the card and hide the buttons
        inside it rather than scroll to them. */}
      <Card size="sm" className="flex-none">
        <CardHeader>
          {/* A div by construction (`ui/card.tsx`), so it says out loud that it is
            still the heading of this block, at the level the sibling "In this
            collection" heading uses. */}
          <CardTitle role="heading" aria-level={3}>
            Publishing
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.8125rem]">
            {published ? (
              <>
                <Globe className="size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Published by <span className="font-semibold text-foreground">{publisher}</span>
                </span>
              </>
            ) : (
              <>
                <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                <span>Household only — this collection isn’t on the network.</span>
              </>
            )}
          </CardDescription>
        </CardHeader>

        {/* Nothing to say and nothing to press — a member looking at a healthy
          published collection — leaves the card as its header alone, rather than
          an empty content slot padding the bottom of it. */}
        {(stale || isOwner) && (
          <CardContent className="flex flex-col gap-2">
            {stale && (
              // Not an error state: the local rows are saved and every later write
              // tries again on its own. It is an annotation with a way to hurry it up,
              // and it is shown to members as well as owners.
              <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-border bg-muted/50 px-2.5 py-2">
                <Badge size="xs" variant="destructive">
                  Out of date
                </Badge>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">{publisher}’s published copy is behind what’s here.</span>
                <Button
                  type="button"
                  variant="outline"
                  size={mobile ? undefined : "xs"}
                  className={touchButton}
                  disabled={!online || retrying}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  onClick={() => void onRetrySync()}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              </div>
            )}

            {isOwner && (
              <div className="flex flex-wrap items-center gap-2">
                {published ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={touchButton}
                    disabled={!online}
                    title={online ? undefined : OFFLINE_WRITE_HINT}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setFailure(null);
                      setUnpublishOpen(true);
                    }}
                  >
                    <EyeOff data-icon="inline-start" aria-hidden="true" />
                    Unpublish
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className={touchButton}
                    disabled={!online}
                    title={online ? undefined : OFFLINE_WRITE_HINT}
                    aria-haspopup="dialog"
                    onClick={() => {
                      setFailure(null);
                      setBlockedIds([]);
                      setPublishOpen(true);
                    }}
                  >
                    <Globe data-icon="inline-start" aria-hidden="true" />
                    Publish collection
                  </Button>
                )}

                <Button
                  type="button"
                  variant="ghost"
                  className={mobile ? "h-11 text-destructive" : "text-destructive"}
                  disabled={!online}
                  title={online ? undefined : OFFLINE_WRITE_HINT}
                  aria-haspopup="dialog"
                  onClick={() => {
                    setFailure(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                  Delete collection
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Portalled the moment they open, so they sit outside the card rather
        than inside a container that clips its own overflow. */}
      <PublishConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        collectionName={collection.name}
        ownerHandle={myHandle}
        blockedTitles={blockedTitles}
        failure={failure}
        pending={pending}
        touch={mobile}
        onConfirm={() => void onPublish()}
      />

      <UnpublishConfirmDialog
        open={unpublishOpen}
        onOpenChange={setUnpublishOpen}
        collectionName={collection.name}
        publisherHandle={collection.publishedByHandle}
        failure={failure}
        pending={pending}
        touch={mobile}
        onConfirm={() => void onUnpublish()}
      />

      <DeleteCollectionDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        collectionName={collection.name}
        published={published}
        publisherHandle={collection.publishedByHandle}
        failure={failure}
        pending={pending}
        touch={mobile}
        onConfirm={() => void onDelete()}
      />

      <AtprotoReauthDialog open={reauthOpen} onOpenChange={setReauthOpen} touch={mobile} />
    </>
  );
}
