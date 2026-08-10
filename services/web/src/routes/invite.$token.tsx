import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DoorOpen, UtensilsCrossed } from "lucide-react";
import { useHydratedSession } from "#/lib/auth-client";
import { getInvitePreview, acceptInvite, declineBoundInvite } from "#/server/household/invites";
import { stashPendingInvite, clearPendingInvite, errorMessage } from "#/server/household/pending-invite";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "#/lib/seo";
import type { InvitePreview } from "#/server/household/invites";

type LoaderData = { ok: true; token: string; preview: InvitePreview } | { ok: false; token: string; message: string };

/** Invite acceptance (§10, §15). The preview loader needs NO auth, so this route
 * renders for logged-out visitors too — they sign in first and are returned here
 * via the pending-invite cookie (see `server/household/pending-invite.ts`). */
export const Route = createFileRoute("/invite/$token")({
  loader: async ({ params }): Promise<LoaderData> => {
    try {
      const preview = await getInvitePreview({ data: { token: params.token } });
      return { ok: true, token: params.token, preview };
    } catch (err) {
      return { ok: false, token: params.token, message: errorMessage(err, "This invite link is not valid.") };
    }
  },
  head: () => ({ meta: seo({ title: "You're invited · Buttery", description: "Accept your invitation to a Buttery household." }) }),
  component: InvitePage,
});

function InvitePage() {
  const data = Route.useLoaderData();
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in mx-auto flex max-w-md flex-col gap-6">
        {data.ok ? <ValidInvite token={data.token} preview={data.preview} /> : <InvalidInvite message={data.message} />}
      </div>
    </div>
  );
}

function InvalidInvite({ message }: { message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={1} className="display-title flex items-center gap-2 text-xl">
          <UtensilsCrossed aria-hidden="true" className="size-5" />
          Invite unavailable
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="m-0 text-sm text-muted-foreground">{message}</p>
        <Button render={<Link to="/onboarding" />} nativeButton={false}>
          Go to get started
        </Button>
      </CardContent>
    </Card>
  );
}

function ValidInvite({ token, preview }: { token: string; preview: InvitePreview }) {
  const { data: session, isPending: sessionPending } = useHydratedSession();
  const navigate = useNavigate();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    setError(null);
    setPending("accept");
    try {
      await acceptInvite({ data: { token } });
      clearPendingInvite();
      await navigate({ to: "/households" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  async function onDecline() {
    setError(null);
    setPending("decline");
    try {
      await declineBoundInvite({ data: { token } });
      clearPendingInvite();
      await navigate({ to: "/onboarding" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  function onSignInToAccept() {
    // Carry the token through the atproto OAuth round-trip: the callback always
    // lands on "/", so we stash the token and resume from there (see
    // routes/index.tsx PendingInviteResume).
    stashPendingInvite(token);
    void navigate({ to: "/login" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={1} className="display-title flex items-center gap-2 text-xl">
          <DoorOpen aria-hidden="true" className="size-5" />
          You're invited
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <div>
          <p className="m-0 text-lg font-bold text-foreground">{preview.householdName}</p>
          <p className="m-0 text-sm text-muted-foreground">
            {preview.inviterHandle ? <>@{preview.inviterHandle} invited you to join</> : <>You've been invited to join this household</>} as{" "}
            <Badge variant={preview.role === "owner" ? "secondary" : "outline"}>{preview.role}</Badge>
          </p>
        </div>

        {sessionPending ? (
          <Skeleton className="h-8 w-40" />
        ) : session ? (
          <div className="flex w-full flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={onAccept} disabled={pending !== null}>
                {pending === "accept" ? <Spinner data-icon="inline-start" /> : null}
                Accept invite
              </Button>
              <Button variant="ghost" onClick={onDecline} disabled={pending !== null}>
                {pending === "decline" ? <Spinner data-icon="inline-start" /> : null}
                Decline
              </Button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              Signed in as <code className="break-all">{session.user.name}</code>
            </p>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">Sign in with your atproto handle to accept. We'll bring you right back here afterward.</p>
            <Button onClick={onSignInToAccept}>Sign in to accept</Button>
          </div>
        )}

        {error ? (
          <p role="alert" className="m-0 text-sm font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
