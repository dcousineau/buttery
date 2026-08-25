import { ConfirmDialog } from "#/components/ConfirmDialog";
import { publisherName } from "./use-stale-toast";

/**
 * "Unpublish this collection?" — §2.7's first warning dialog.
 *
 * Unpublishing is a `deleteRecord` on the publisher's PDS and nothing else: the
 * collection, its description and every recipe filed in it stay exactly where they
 * are locally. That is the first half of the copy.
 *
 * The second half is the one this app must never leave out. Deleting a record
 * from a PDS removes it from **that PDS**; it does not reach the relays,
 * mirrors, appviews and caches that may already have read it. Buttery is
 * built on an open network and says so plainly (BRAND.md) — including when the
 * honest answer is "we cannot take this back for you".
 *
 * The publisher may not be the person reading this (§2.5), so the PDS is named
 * by *their* handle rather than called "yours".
 */
export function UnpublishConfirmDialog({
  open,
  onOpenChange,
  collectionName,
  publisherHandle,
  failure,
  pending,
  touch,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collectionName: string;
  /** Whose repo the record lives in — `publishedByHandle`, not the acting owner. */
  publisherHandle: string | null;
  failure: string | null;
  pending: boolean;
  touch: boolean;
  onConfirm: () => void;
}) {
  const who = publisherName(publisherHandle);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Unpublish this collection?"
      description={
        <>
          This deletes the record from {who}’s PDS. <span className="font-semibold text-foreground">{collectionName}</span> and everything on it stay in your box — only the public
          copy goes. Deleting from a PDS doesn’t guarantee removal from the wider internet: relays, mirrors and caches may already hold a copy.
        </>
      }
      confirmLabel="Unpublish"
      destructive
      pending={pending}
      touch={touch}
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
