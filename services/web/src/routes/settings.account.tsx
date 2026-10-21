import { createFileRoute } from "@tanstack/react-router";
import UserAvatar from "#/components/UserAvatar";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { serviceNameFromPds } from "#/lib/atproto/service-name";
import { useHydratedSession } from "#/lib/auth-client";
import { seo } from "#/lib/seo";
import type { ReactNode } from "react";

export const Route = createFileRoute("/settings/account")({
  head: () => ({
    meta: seo({ title: "Account · Buttery", description: "The atproto account you're signed in to Buttery with." }),
  }),
  component: AccountPage,
});

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <dt className="text-sm font-semibold text-muted-foreground sm:w-32 sm:shrink-0">{label}</dt>
      <dd className="m-0 min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

function AccountPage() {
  const { data: session, isPending } = useHydratedSession();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground">Account</h1>
        <p className="m-0 text-sm text-muted-foreground">
          This is the atproto account you're signed in with. Nothing here is editable yet — your handle, photo and server all live with your account provider.
        </p>
      </header>

      {isPending ? (
        <Card>
          <CardContent className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="size-14 rounded-full" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
          </CardContent>
        </Card>
      ) : session ? (
        <AccountCard user={session.user} />
      ) : (
        <Card>
          <CardContent>
            <p className="m-0 text-sm text-muted-foreground">You're not signed in, so there's no account to show.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AccountCard({ user }: { user: { name: string; handle?: string | null; did?: string | null; image?: string | null; pds?: string | null } }) {
  const handle = user.handle ?? user.name;
  const service = serviceNameFromPds(user.pds);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-4">
          <UserAvatar handle={handle} image={user.image} size="xl" />
          <CardTitle role="heading" aria-level={2} className="display-title min-w-0 text-xl break-all">
            {handle}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="m-0 flex flex-col gap-4">
          <Row label="Handle">
            <code className="break-all">{handle}</code>
          </Row>
          {user.did ? (
            <Row label="Identity (DID)">
              <code className="break-all">{user.did}</code>
            </Row>
          ) : null}
          {service ? <Row label="Account provider">{service}</Row> : null}
          {user.pds ? (
            <Row label="Server (PDS)">
              <code className="break-all">{user.pds}</code>
            </Row>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}
