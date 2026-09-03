import { ConfirmDialog } from "#/components/ConfirmDialog";
import { publisherName } from "./use-stale-toast";

/**
 * "Delete this collection?" — §2.7's second warning dialog, built on the shared
 * `ConfirmDialog` like every other destructive confirm in the app.
 *
 * Three things the copy has to be straight about:
 *
 * - **The recipes survive.** Deleting a collection deletes the collection. Nothing leaves
 *   the box, which is the fear the word "delete" produces here.
 * - **The published record goes too**, from the publisher's PDS — the server
 *   deletes it *first* and only takes the local rows if that succeeded (§5), so
 *   a failure here means nothing was deleted anywhere and the failure text says
 *   exactly that.
 * - **A PDS delete is not an internet delete.** Same caveat as unpublishing, for
 *   the same reason: relays, mirrors and caches may already hold a copy, and
 *   Buttery does not get to promise otherwise.
 *
 * An unpublished collection gets the first point only — inventing a PDS caveat for a
 * record that never existed would teach people to ignore it on the one that did.
 */
export function DeleteCollectionDialog({
  open,
  onOpenChange,
  collectionName,
  published,
  publisherHandle,
  failure,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  published: boolean;
  publisherHandle: string | null;
  failure: string | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  const who = publisherName(publisherHandle);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this collection?"
      description={
        published ? (
          <>
            This deletes <span className="font-semibold text-foreground">{collectionName}</span> from your box and deletes its record from {who}’s PDS. Your recipes stay where they
            are — only the collection goes. Deleting from a PDS doesn’t guarantee removal from the wider internet: relays, mirrors and caches may already hold a copy.
          </>
        ) : (
          <>
            This deletes <span className="font-semibold text-foreground">{collectionName}</span> from your box. Your recipes stay where they are — only the collection goes.
          </>
        )
      }
      confirmLabel="Delete collection"
      destructive
      pending={pending}
      onConfirm={onConfirm}
    >
      {failure && (
        <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
          {failure}
        </p>
      )}
    </ConfirmDialog>
  );
}
