import { ConfirmDialog } from "#/components/ConfirmDialog";
import { publisherName } from "./use-stale-toast";

/**
 * "Publish this collection?" — the dialog §2.5 writes the copy for.
 *
 * Two facts have to be on screen before anyone confirms, and neither is
 * guessable from the button:
 *
 * 1. **Whose PDS the record lands on.** Publishing is done as the acting owner,
 *    so the record is created in *their* repo and lives in their account — not
 *    the household's, which owns no repo, and not Buttery's.
 * 2. **Who future updates come from.** A published collection is re-put through
 *    the publisher's stored session on every later edit, by any member (§2.5).
 *    So a collection someone else rearranges still goes out over the publisher's
 *    handle, and the person clicking Publish is the one signing all of it.
 *
 * The `blockedTitles` list is the §2.4 preflight, shown here rather than as a
 * toast because it is a list of things to go and do, not a notification.
 */
export function PublishConfirmDialog({
  open,
  onOpenChange,
  collectionName,
  /** The acting owner's handle — they become `published_by_did`. */
  ownerHandle,
  blockedTitles,
  failure,
  pending,
  touch,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  ownerHandle: string | null;
  /** Recipes in the collection that are still private, from `recipes_unpublished`. */
  blockedTitles: string[];
  /** A refusal to keep on screen — the dialog stays open holding it. */
  failure: string | null;
  pending: boolean;
  touch: boolean;
  onConfirm: () => void;
}) {
  const who = publisherName(ownerHandle);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Publish this collection?"
      description={
        <>
          This writes <span className="font-semibold text-foreground">{collectionName}</span> to your own atproto account, {who} — the record lives on your PDS, where any app on
          the network can read it. Everyone in your household can still edit the collection, and every future update to it goes out from {who} too, whichever member makes the edit.
        </>
      }
      confirmLabel="Publish collection"
      pending={pending}
      touch={touch}
      onConfirm={onConfirm}
    >
      {blockedTitles.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="status">
          <p className="m-0 font-semibold">
            {blockedTitles.length === 1 ? "One recipe in this collection is still private" : `${blockedTitles.length} recipes in this collection are still private`}
          </p>
          <p className="m-0">
            A published collection can only point at published recipes. Publish {blockedTitles.length === 1 ? "it" : "them"} first, then publish the collection.
          </p>
          {/* Capped: a collection can refuse with thirty titles, and an uncapped list
            pushes the dialog's own buttons off a phone screen. */}
          <ul className="m-0 flex max-h-[8.5rem] list-disc flex-col gap-0.5 overflow-auto pl-4 font-semibold">
            {blockedTitles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </div>
      )}

      {failure && (
        <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
          {failure}
        </p>
      )}
    </ConfirmDialog>
  );
}
