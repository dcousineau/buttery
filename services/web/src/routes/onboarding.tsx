import { useState } from "react";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { Mail, MailQuestion, Plus } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { resolveOnboarding, acceptBoundInviteById, declineBoundInviteById } from "#/server/household/onboarding";
import { createHousehold } from "#/server/household/households";
import { errorMessage } from "#/server/household/pending-invite";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Separator } from "#/components/ui/separator";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "#/lib/seo";
import type { PendingInvite } from "#/server/household/onboarding";
import type { FormEvent } from "react";

/** The single onboarding screen (§5/§10) for users with no live membership.
 * Loader resolves the state machine: an already-active user is bounced into the
 * app; a multi-membership user to the picker; everyone else lands here. */
export const Route = createFileRoute("/onboarding")({
  loader: async () => {
    const verdict = await resolveOnboarding();
    if (verdict.kind === "active") throw redirect({ to: "/pantry" });
    if (verdict.kind === "pick") throw redirect({ to: "/households/switch" });
    return { pendingInvites: verdict.pendingInvites };
  },
  head: () => ({ meta: seo({ title: "Get started · Buttery", description: "Join a household or create your own." }) }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const { pendingInvites } = Route.useLoaderData();
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            Get started
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">Join a household</h1>
          <p className="mt-3 mb-0 text-sm text-muted-foreground sm:text-base">
            A <strong className="text-foreground">household</strong> is your private, shared space in Buttery. Most people join one someone else already set up — if you're
            expecting an invite, hold tight and it'll show up right here.
          </p>
        </header>

        <PendingInvites invites={pendingInvites} />

        <PasteInviteCard />

        <Separator />

        <CreateHouseholdCard />
      </div>
    </div>
  );
}

function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  if (invites.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="display-title flex items-center gap-2 text-lg">
            <MailQuestion aria-hidden="true" className="size-5" />
            No invitations yet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-sm text-muted-foreground">
            When someone invites you to their household, it'll appear here for you to accept. Waiting for an invite is the easiest way in — you don't need to create anything
            yourself.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="display-title m-0 flex items-center gap-2 text-lg text-foreground">
        <Mail aria-hidden="true" className="size-5" />
        Your invitations
      </h2>
      {invites.map((invite) => (
        <PendingInviteCard key={invite.inviteId} invite={invite} />
      ))}
    </section>
  );
}

function PendingInviteCard({ invite }: { invite: PendingInvite }) {
  const navigate = useNavigate();
  const router = useRouter();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    setError(null);
    setPending("accept");
    try {
      await acceptBoundInviteById({ data: { inviteId: invite.inviteId } });
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
      await declineBoundInviteById({ data: { inviteId: invite.inviteId } });
      // Re-run the loader so the declined invite drops out of the list.
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="m-0 text-base font-bold text-foreground">{invite.householdName}</p>
            <p className="m-0 text-sm text-muted-foreground">{invite.inviterHandle ? <>Invited by @{invite.inviterHandle}</> : <>You've been invited to join</>}</p>
          </div>
          <Badge variant={invite.role === "owner" ? "secondary" : "outline"}>{invite.role}</Badge>
        </div>
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
        {error ? (
          <p role="alert" className="m-0 text-sm font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Extract the raw token from a pasted `/invite/<token>` link, or treat the whole
 * string as the token when a bare token was pasted. */
function extractToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const marker = "/invite/";
  const idx = trimmed.indexOf(marker);
  if (idx !== -1) {
    const rest = trimmed.slice(idx + marker.length);
    // Drop any trailing query/hash and path noise.
    const token = rest.split(/[/?#]/)[0];
    return token || null;
  }
  // No marker: assume the user pasted the bare token (no spaces / slashes).
  if (/[\s/]/.test(trimmed)) return null;
  return trimmed;
}

function PasteInviteCard() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const token = extractToken(value);
    if (!token) {
      setError("Paste the full invite link you were given.");
      return;
    }
    setError(null);
    void navigate({ to: "/invite/$token", params: { token } });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-lg">
          Have an invite link?
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="invite-link">Paste your invite link</FieldLabel>
              <Input
                id="invite-link"
                type="text"
                size="lg"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="https://buttery.recipes/invite/…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "invite-link-error" : undefined}
              />
            </Field>
          </FieldGroup>
          <Button type="submit" variant="secondary" className="mt-4">
            Open invite
          </Button>
          {error ? (
            <p id="invite-link-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** Create-household is always available but visually SECONDARY (§5 guardrail 3),
 * wrapped in copy nudging toward waiting for an invite. On the onboarding screen
 * the caller has zero memberships, so no second-household confirm is needed here
 * (that lives on the management surface, acceptance item 11). */
function CreateHouseholdCard() {
  const navigate = useNavigate();
  const { posthog } = useAnalytics();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give your household a name.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await createHousehold({ data: { name: name.trim() } });
      posthog.capture("household_created", { creation_surface: "onboarding" });
      await navigate({ to: "/households" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-sm font-semibold text-muted-foreground">Starting fresh?</h2>
      <p className="m-0 text-sm text-muted-foreground">
        If nobody's invited you yet, you can create your own household. Most people only ever need one — you can always invite others once it exists.
      </p>
      <form onSubmit={onSubmit} className="mt-2">
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="household-name">Household name</FieldLabel>
            <Input
              id="household-name"
              type="text"
              size="lg"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The Cousineau kitchen"
              maxLength={100}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "household-name-error" : undefined}
            />
          </Field>
        </FieldGroup>
        <Button type="submit" variant="outline" disabled={pending} className="mt-4">
          {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
          Create a household
        </Button>
        {error ? (
          <p id="household-name-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
