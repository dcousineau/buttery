import { useId, useRef } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { type Mutation, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { Compass, CopyCheck, Plus, Replace, X } from "lucide-react";
import { addRecipeToBoxMutation, addRecipeToHousehold, type HouseholdRecipeDetail, keys, mutationKeys, removeRecipeFromHousehold } from "#/lib/api";
import { OFFLINE_WRITE_HINT, useIsOnline } from "#/lib/offline/use-online";
import { Button } from "#/components/ui/button";
import { Img } from "#/components/ui/img";
import { Spinner } from "#/components/ui/spinner";
import { useRecipesView } from "./context";
import { RecipeSlat, RecipeSlatAction, RecipeSlatBody, RecipeSlatList, RecipeSlatMeta, RecipeSlatTitle } from "./RecipeSlat";

/**
 * The "not in your box yet" treatment for a public recipe opened on a household
 * surface, in its two placements: {@link NotInBoxNotice}, the bar under the
 * recipe title in the detail pane, and {@link NotInBoxLedgerItem}, the row the
 * ledger shows above its list so the recipe you are reading has a place in the
 * column beside it. Both save through {@link useSaveToBox}, so they share one
 * mutation, one pending state and one pair of toasts.
 *
 * What each placement SAYS is {@link NOT_IN_BOX_COPY}, keyed by
 * {@link NotInBoxVariant} — why the reader is looking at a recipe they do not
 * keep. Callers pick a variant (and may override single strings with `copy`)
 * rather than restyling either component. A `replaces` id (the `$id` route's
 * `?replaces=`) picks `duplicate` and turns the save into a swap.
 */

/**
 * Why this recipe is on screen without being in the box: `public` — read from
 * outside it; `duplicate` — opened from the duplicate-publish toast, so the
 * reader's own copy of it is in the box already.
 */
export type NotInBoxVariant = "public" | "duplicate";

export interface NotInBoxCopy {
  /** The bar's heading, and the name of its landmark. */
  title: string;
  /** The bar's sentence: what saving gets you. */
  body: string;
  /** The ledger row's second line, in place of the source a boxed row shows. */
  ledgerHint: string;
  /** The save button, idle. */
  action: string;
  /** The ledger row's narrower save button; its accessible name is `action` plus the title. */
  ledgerAction: string;
  /** The save button, in flight. */
  pending: string;
}

export const NOT_IN_BOX_COPY: Record<NotInBoxVariant, NotInBoxCopy> = {
  public: {
    title: "Not in your box yet",
    body: "You’re reading a public recipe. Save it to your box to keep it on your shelf, plan it, shop for it and add notes.",
    ledgerHint: "Not in your box · save it to keep it",
    action: "Save to my box",
    ledgerAction: "Save",
    pending: "Saving…",
  },
  duplicate: {
    title: "You already have a copy of this in your box",
    body: "Swap your copy for this public recipe, so your box keeps the one everyone else sees.",
    ledgerHint: "Your copy is in your box · replace it",
    action: "Replace my copy",
    ledgerAction: "Replace",
    pending: "Replacing…",
  },
};

function resolveCopy(variant: NotInBoxVariant, copy: Partial<NotInBoxCopy> | undefined): NotInBoxCopy {
  return { ...NOT_IN_BOX_COPY[variant], ...copy };
}

/**
 * Save one recipe to the box, from whichever placement was pressed — or, with
 * `replaces`, swap the reader's own copy of it for this one.
 *
 * A replace is add-then-remove, in that order, so a failure part-way leaves the
 * reader with both recipes rather than neither: an add that fails stops before
 * the remove and says so like any failed save; a remove that fails after the
 * add says the old copy is still there. Removing the copy is the same unbox the
 * detail pane's Remove does — it leaves the household, while its recipe row
 * (a private draft) stays where it is.
 *
 * The toasts and the param clearing ride on the mutation's own options, not on
 * `mutate`'s per-call callbacks: a successful save removes both placements (the
 * refetched detail says `inBox: true`, the ledger gains the real row), and
 * query-core drops per-call callbacks once their observer has unmounted.
 * `saving` reads every in-flight save of this recipe through
 * `useMutationState`, so pressing one placement disables the other too.
 */
export function useSaveToBox(householdId: string, recipeId: string, replaces?: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { pushToast } = useRecipesView();
  const online = useIsOnline();
  const base = addRecipeToBoxMutation(queryClient, householdId);
  const mutation = useMutation({
    ...base,
    mutationFn: async (vars: { recipeId: string; replaces?: string }) => {
      const added = await addRecipeToHousehold(vars.recipeId);
      if (!vars.replaces) return { ...added, removedCopy: null };
      try {
        await removeRecipeFromHousehold(vars.replaces);
        return { ...added, removedCopy: true };
      } catch (err) {
        console.error("removeRecipeFromHousehold failed", err);
        return { ...added, removedCopy: false };
      }
    },
    onSuccess: async (data, vars, ...rest) => {
      // The add's own invalidations (box list + this detail), plus the removed copy's detail.
      await Promise.all([
        base.onSuccess?.(data, vars, ...rest),
        vars.replaces ? queryClient.invalidateQueries({ queryKey: keys.household.recipe(householdId, vars.replaces) }) : undefined,
      ]);
      if (data.removedCopy === null) {
        pushToast("Added to your box");
        return;
      }
      pushToast(data.removedCopy ? "Replaced your copy" : "Added this one, but couldn’t remove your old copy — it’s still in your box.", {
        variant: data.removedCopy ? "default" : "destructive",
      });
      // The recipe is boxed now, so the offer is spent either way. Only while
      // the reader is still on it: they may have moved on during the round trip.
      if (router.state.location.search.replaces === vars.replaces) clearReplaces(router, vars.recipeId);
    },
    onError: (err: Error) => {
      console.error("addRecipeToHousehold failed", err);
      pushToast("That one didn't make it into the box. Try again.", { variant: "destructive" });
    },
  });
  const inFlight = useMutationState({
    filters: {
      mutationKey: mutationKeys.recipeAddedToBox,
      status: "pending",
      predicate: (m: Mutation<unknown, Error, unknown>) => (m.state.variables as { recipeId?: string } | undefined)?.recipeId === recipeId,
    },
  });
  return {
    save: () => mutation.mutate({ recipeId, replaces }),
    saving: inFlight.length > 0,
    // Writes are online-only (see `lib/api/mutations.ts`): disable, and say why.
    disabledReason: online ? undefined : OFFLINE_WRITE_HINT,
  };
}

/** Drop `?replaces=` from the recipe's URL, in place: a spent or declined offer is not a step worth going Back to. */
function clearReplaces(router: ReturnType<typeof useRouter>, recipeId: string) {
  void router.navigate({ to: "/household/recipes/$id", params: { id: recipeId }, search: (prev) => ({ ...prev, replaces: undefined }), replace: true });
}

interface NotInBoxProps {
  householdId: string;
  recipeId: string;
  /** The reader's own copy of this recipe, to swap out on save. Picks the `duplicate` variant. */
  replaces?: string;
  variant?: NotInBoxVariant;
  /** Per-string overrides on top of the variant's copy. */
  copy?: Partial<NotInBoxCopy>;
}

/**
 * The detail pane's bar. A plain `aside` labelled by its own title — static
 * content, so no live region. It sits directly under the recipe title rather
 * than above it: the pane moves focus to the title on mount, so this is the
 * next thing a screen reader reads, where above the title it would be skipped.
 */
export function NotInBoxNotice({ householdId, recipeId, replaces, variant = replaces ? "duplicate" : "public", copy }: NotInBoxProps) {
  const titleId = useId();
  const router = useRouter();
  const actionRef = useRef<HTMLButtonElement>(null);
  const text = resolveCopy(variant, copy);
  const { save, saving, disabledReason } = useSaveToBox(householdId, recipeId, replaces);
  const Icon = variant === "duplicate" ? CopyCheck : Compass;
  const ActionIcon = replaces ? Replace : Plus;
  return (
    <aside
      aria-labelledby={titleId}
      data-variant={variant}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border-2 border-border bg-accent px-4 py-3 text-accent-foreground shadow-pop-sm"
    >
      <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-2.5">
        <Icon className="mt-0.5 size-5 flex-none" aria-hidden="true" />
        <div className="min-w-0">
          <p id={titleId} className="m-0 text-sm font-bold">
            {text.title}
          </p>
          <p className="m-0 text-[0.8125rem] text-pretty">{text.body}</p>
        </div>
      </div>
      <Button ref={actionRef} size="lg" disabled={saving || disabledReason !== undefined} title={disabledReason} onClick={save}>
        {saving ? <Spinner data-icon="inline-start" /> : <ActionIcon data-icon="inline-start" aria-hidden="true" />}
        {saving ? text.pending : text.action}
      </Button>
      {/* Declining the swap only forgets the offer: the bar goes back to plain
        "not in your box". The X leaves with it, so focus moves to the save
        button, which stays put, rather than falling to <body>. */}
      {replaces && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          className="-mr-1 self-start"
          disabled={saving}
          onClick={() => {
            clearReplaces(router, recipeId);
            actionRef.current?.focus();
          }}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </aside>
  );
}

/**
 * The ledger's row for the recipe being read when it is not in the box. It is
 * its own one-item list above the ledger's, never one of its rows: the filter's
 * results and counts describe the box, and this recipe is not in it. Always the
 * selected row — it only exists while its recipe is the one on screen — so it
 * carries the butter marker and `aria-current`, like the boxed row that takes
 * its place once the save lands.
 *
 * The save button sits outside the link, in the slat's trailing slot, because
 * a button inside an anchor is invalid and unreachable by keyboard.
 */
export function NotInBoxLedgerItem({
  householdId,
  recipe,
  replaces,
  variant = replaces ? "duplicate" : "public",
  copy,
}: Omit<NotInBoxProps, "recipeId"> & { recipe: Pick<HouseholdRecipeDetail, "recipeId" | "title" | "images"> }) {
  const text = resolveCopy(variant, copy);
  const { save, saving, disabledReason } = useSaveToBox(householdId, recipe.recipeId, replaces);
  const ActionIcon = replaces ? Replace : Plus;
  const thumb = recipe.images[0]?.url ?? null;
  return (
    <RecipeSlatList aria-label={text.title} data-variant={variant} className="border-b-2 border-border">
      <RecipeSlat selected>
        <RecipeSlatAction render={<Link to="/household/recipes/$id" params={{ id: recipe.recipeId }} search={(prev) => prev} />} aria-current="page">
          <Img
            src={thumb}
            alt=""
            className="size-11 flex-none rounded-sm border-2 border-border object-cover"
            fallback={
              <span className="grid size-11 flex-none place-content-center rounded-sm border-2 border-border bg-muted">
                <Compass className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
            }
          />
          <RecipeSlatBody>
            <RecipeSlatTitle>
              <span className="truncate">{recipe.title}</span>
            </RecipeSlatTitle>
            <RecipeSlatMeta className="flex items-center gap-1">
              <Compass className="size-2.75 shrink-0" aria-hidden="true" />
              <span className="truncate">{text.ledgerHint}</span>
            </RecipeSlatMeta>
          </RecipeSlatBody>
        </RecipeSlatAction>
        <Button
          size="sm"
          variant="outline"
          className="flex-none"
          aria-label={`${saving ? text.pending : text.action}: ${recipe.title}`}
          disabled={saving || disabledReason !== undefined}
          title={disabledReason}
          onClick={save}
        >
          {saving ? <Spinner data-icon="inline-start" /> : <ActionIcon data-icon="inline-start" aria-hidden="true" />}
          {saving ? text.pending : text.ledgerAction}
        </Button>
      </RecipeSlat>
    </RecipeSlatList>
  );
}
