import { useState } from "react";
import { reconnectAtproto } from "#/lib/atproto-reauth";
import { useHydratedSession } from "#/lib/auth-client";
import { ConfirmDialog } from "#/components/ConfirmDialog";

/**
 * "Buttery needs new permissions" — the one prompt every `scope_error` routes to.
 *
 * An atproto grant is frozen at the scopes it was issued with, so a session
 * created before `repo:exchange.recipe.collection` existed keeps refusing every
 * write that needs it (`lib/atproto-reauth.ts`). The only fix is to walk the
 * same authorization the login screen walks, which is what confirming here does.
 *
 * It exists as a component because the collections feature has **four** places
 * that can hit that refusal — publishing, unpublishing and deleting a shelf, and
 * the "Publish recipe & add" combo in each of the two filing surfaces — and four
 * copies of this copy would drift the first time one of them was edited. The
 * wording deliberately says "publishing" rather than naming a recipe or a shelf,
 * so the one dialog is honest wherever it is opened from.
 *
 * (`DetailPane` and `RecipeForm` still carry their own recipe-specific wording
 * from before this existed; folding them in is a tidy-up for whoever owns those
 * files next, not a collections change.)
 *
 * On success the browser navigates away to the authorization server, so there is
 * no "it worked" state to render — only the failure, which stays in the dialog
 * rather than vanishing with it.
 */
export function AtprotoReauthDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // `handle` is an atproto-plugin column, absent from better-auth's base user type.
  const { data: session } = useHydratedSession() as { data: { user?: { handle?: string | null } } | null };
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");

  async function onConfirm() {
    setPending(true);
    setFailure("");
    const message = await reconnectAtproto(session?.user?.handle);
    // Only reached when the redirect did not happen.
    if (message) {
      setPending(false);
      setFailure(message);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFailure("");
        onOpenChange(next);
      }}
      title="Buttery needs new permissions"
      description="Publishing writes to your own atproto account, and that permission was added after you last signed in. Reconnect to grant it — you'll come back here and can try again. Nothing is published until then."
      confirmLabel="Reconnect account"
      cancelLabel="Not now"
      pending={pending}
      onConfirm={() => void onConfirm()}
    >
      {failure ? (
        <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
          {failure}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
