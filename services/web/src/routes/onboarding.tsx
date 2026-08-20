import { useState } from "react";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { Check, Copy, House, Link2, Mail, MailQuestion, Plus, RotateCw } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { resolveOnboarding, acceptBoundInviteById, declineBoundInviteById } from "#/lib/api";
import { createHousehold } from "#/lib/api";
import { errorMessage } from "#/lib/api";
import { useHydratedSession } from "#/lib/auth-client";
import { formatPublished } from "#/lib/format";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "#/lib/seo";
import type { PendingInvite } from "#/lib/api";
import type { FormEvent } from "react";
import { refreshSession } from "#/lib/auth-client";

/**
 * The onboarding CHOOSER (`/onboarding`) — the screen a user with no live
 * membership is held on until they are a member of exactly one household.
 *
 * The loader resolves the §5 state machine: an already-active user is bounced
 * into the pantry; a multi-membership user to the picker; everyone else lands
 * here. Onboarding HOLDS — every way out of this screen ends at `/household`,
 * the same pantry every later login lands on, so a first-time user never meets
 * the management surface as their first impression of the app.
 *
 * Two ways in, presented as two chips rather than a stack: **join** (the pending
 * invites, the handle to hand out, and the paste-a-link field) and **create**
 * (one name). Neither is demoted — reaching either panel is already a deliberate
 * choice, so the create form gets the default button variant, not the outline it
 * used to wear when it sat below a separator.
 */
export const Route = createFileRoute("/onboarding")({
  loader: async () => {
    const verdict = await resolveOnboarding();
    if (verdict.kind === "active") throw redirect({ to: "/household" });
    if (verdict.kind === "pick") throw redirect({ to: "/households/switch" });
    return { pendingInvites: verdict.pendingInvites };
  },
  head: () => ({ meta: seo({ title: "Get started · Buttery", description: "Join a household or create your own." }) }),
  component: OnboardingPage,
});

/** Which chip is pressed. `null` is a real state — "haven't chosen yet". */
type Tab = "join" | "create" | null;

const JOIN_PANEL_ID = "onboarding-panel-join";
const CREATE_PANEL_ID = "onboarding-panel-create";
const JOIN_TAB_ID = "onboarding-tab-join";
const CREATE_TAB_ID = "onboarding-tab-create";

/** The hairline between rows inside a card — the system's one sanctioned 1px rule. */
const HAIRLINE = "h-px bg-border/60";

function OnboardingPage() {
  const { pendingInvites } = Route.useLoaderData();
  // Invites waiting means the answer is almost certainly "join", so the tab
  // opens there. With nothing waiting we deliberately choose NOTHING: the
  // no-tab panel is what explains the two ways in, and pre-selecting create
  // would put a form in front of someone who may just need to wait.
  const [tab, setTab] = useState<Tab>(pendingInvites.length > 0 ? "join" : null);
  const count = pendingInvites.length;

  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            Get started
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">Welcome to the pantry</h1>
          <p className="mt-3 mb-0 text-sm text-pretty text-muted-foreground sm:text-base">
            A <strong className="text-foreground">household</strong> is your private, shared space in Buttery — the recipes, the list, the week&rsquo;s plan. You need one to get
            going, and there are exactly two ways in.
          </p>
        </header>

        <div role="tablist" aria-label="How you're getting in" className="flex flex-wrap gap-3">
          <Button
            id={JOIN_TAB_ID}
            role="tab"
            type="button"
            size="lg"
            variant={tab === "join" ? "secondary" : "outline"}
            aria-selected={tab === "join"}
            aria-controls={JOIN_PANEL_ID}
            onClick={() => setTab("join")}
            className={tab === "join" ? "rounded-full shadow-pop-sm" : "rounded-full"}
          >
            <Mail data-icon="inline-start" aria-hidden="true" />
            Join a household
            {count > 0 ? (
              <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-border bg-primary px-1.5 text-[0.6875rem] font-bold text-primary-foreground">
                {count}
              </span>
            ) : null}
          </Button>
          <Button
            id={CREATE_TAB_ID}
            role="tab"
            type="button"
            size="lg"
            variant={tab === "create" ? "secondary" : "outline"}
            aria-selected={tab === "create"}
            aria-controls={CREATE_PANEL_ID}
            onClick={() => setTab("create")}
            // Nothing chosen AND nothing waiting: creating is the only way
            // forward, so the chip wears the butter-pale nudge fill until it is
            // either picked or made moot by an invite arriving.
            className={tab === "create" ? "rounded-full shadow-pop-sm" : tab === null && count === 0 ? "rounded-full bg-accent" : "rounded-full"}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Create a household
          </Button>
        </div>

        {tab === null ? <NoChoiceYetCard onChooseCreate={() => setTab("create")} /> : null}

        {tab === "join" ? (
          <div id={JOIN_PANEL_ID} role="tabpanel" aria-labelledby={JOIN_TAB_ID} tabIndex={-1} className="flex flex-col gap-4 focus-visible:outline-none">
            {pendingInvites.map((invite) => (
              <PendingInviteCard key={invite.inviteId} invite={invite} />
            ))}
            <JoinHelpCard hasInvites={count > 0} />
          </div>
        ) : null}

        {tab === "create" ? (
          <div id={CREATE_PANEL_ID} role="tabpanel" aria-labelledby={CREATE_TAB_ID} tabIndex={-1} className="focus-visible:outline-none">
            <CreateHouseholdCard />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The no-tab-chosen panel, shown only when nothing is waiting: two rows that
 * name each way in and what it costs the reader. This is the screen's actual
 * teaching moment — the chips above it are labels, this explains them.
 */
function NoChoiceYetCard({ onChooseCreate }: { onChooseCreate: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Mail aria-hidden="true" className="mt-0.5 size-5 flex-none" />
          <div>
            <p className="m-0 text-[0.9375rem] font-semibold text-foreground">Someone&rsquo;s inviting you</p>
            <p className="mt-1 mb-0 text-sm text-pretty text-muted-foreground">
              Pick <strong className="text-foreground">join</strong> and any invitation shows up there the moment it lands. Nothing to do but wait.
            </p>
          </div>
        </div>

        <div className={HAIRLINE} />

        <div className="flex items-start gap-3">
          <House aria-hidden="true" className="mt-0.5 size-5 flex-none" />
          <div>
            <p className="m-0 text-[0.9375rem] font-semibold text-foreground">Nobody&rsquo;s invited you yet</p>
            <p className="mt-1 mb-0 text-sm text-pretty text-muted-foreground">Start your own. It takes one name, and you can invite the rest of the house the minute it exists.</p>
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={onChooseCreate}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                Name my household
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
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
      await acceptBoundInviteById(invite.inviteId);
      // Every one of these changes `session.active_household_id` server-side, and
      // better-auth's client store only refetches after its own endpoints — so
      // without this the offline cache partition keeps pointing at the previous
      // household until some later window focus, filing the new household's rows
      // under the old one's buster (offline plan §2.4, §2.7).
      await refreshSession();
      await navigate({ to: "/household" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  async function onDecline() {
    setError(null);
    setPending("decline");
    try {
      await declineBoundInviteById(invite.inviteId);
      // Re-run the loader so the declined invite drops out of the list. The join
      // tab stays put — the panel simply falls back to its "no invitations yet"
      // block once the last card leaves.
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  const when = formatPublished(invite.createdAt);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="display-title m-0 text-lg leading-tight text-foreground">{invite.householdName}</p>
            <p className="mt-1 mb-0 text-sm text-muted-foreground">{invite.inviterHandle ? `Invited by @${invite.inviterHandle} · ${when}` : `Invited ${when}`}</p>
          </div>
          <Badge variant={invite.role === "owner" ? "secondary" : "outline"}>{invite.role}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={onAccept} disabled={pending !== null}>
            {pending === "accept" ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" aria-hidden="true" />}
            {pending === "accept" ? "Joining…" : "Accept invite"}
          </Button>
          <Button size="lg" variant="ghost" onClick={onDecline} disabled={pending !== null}>
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

/**
 * The join panel's standing card: how to be found, and what to do with a link
 * you already have. The "no invitations yet" block on top is conditional — with
 * invites on screen it would be contradicting the cards above it.
 */
function JoinHelpCard({ hasInvites }: { hasInvites: boolean }) {
  const router = useRouter();
  const handle = useGiveableHandle();
  const [checking, setChecking] = useState(false);

  async function checkAgain() {
    setChecking(true);
    try {
      // Invite arrival is manual by design (§3.3): no polling, no focus refetch.
      // One button, one loader re-run.
      await router.invalidate();
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        {hasInvites ? null : (
          <>
            <div className="flex items-start gap-3.5">
              <MailQuestion aria-hidden="true" className="mt-0.5 size-6 flex-none text-muted-foreground" />
              <div className="min-w-0">
                <p className="display-title m-0 text-lg leading-tight text-foreground">No invitations yet</p>
                <p className="mt-1.5 mb-0 text-sm text-pretty text-muted-foreground">
                  Waiting is the easiest way in — you don&rsquo;t have to build anything yourself. When someone adds you, the invite lands right here.
                </p>
                <div className="mt-3">
                  <Button size="sm" variant="ghost" onClick={checkAgain} disabled={checking} className="-ml-2">
                    {checking ? <Spinner data-icon="inline-start" /> : <RotateCw data-icon="inline-start" aria-hidden="true" />}
                    {checking ? "Checking…" : "Check again"}
                  </Button>
                </div>
              </div>
            </div>
            <div className={HAIRLINE} />
          </>
        )}

        {handle ? (
          <>
            <YourHandleRow handle={handle} />
            <div className={HAIRLINE} />
          </>
        ) : null}

        <PasteInviteRow />
      </CardContent>
    </Card>
  );
}

/**
 * The handle this person can actually hand to an inviter, or `null` when there
 * isn't one.
 *
 * The base fallback is the one `components/UserMenu.tsx` uses, so the two chrome
 * surfaces never disagree about what this person is called. The extra rejection
 * is the DID: `name` is the bare DID whenever the auth plugin could not read a
 * handle out of the DID doc (every local dev account, and any account whose
 * handle stopped resolving). A DID is not something an inviter can use —
 * `resolveHandleToDid` requires a domain-shaped handle and rejects it outright —
 * so offering one under "your internet handle" would hand over a string that
 * bounces off the invite form. An absent row is the honest answer.
 *
 * Lifted out of the row so the card can drop the row's hairline with it rather
 * than printing two rules against nothing.
 */
function useGiveableHandle(): string | null {
  const { data: session } = useHydratedSession();
  const candidate = session?.user.handle ?? session?.user.name ?? null;
  return candidate && !candidate.startsWith("did:") ? candidate : null;
}

/**
 * "Give them your handle" — the other half of a bound invite. An inviter needs
 * the invitee's atproto handle to bind one, and the invitee is the only person
 * who can supply it, so the join panel hands it over ready to paste.
 */
function YourHandleRow({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);

  function onCopy() {
    void navigator.clipboard.writeText(`@${handle}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div>
      <p className="m-0 text-[0.9375rem] font-semibold text-foreground">Give them your handle</p>
      <p className="mt-1 mb-3 text-sm text-pretty text-muted-foreground">Whoever&rsquo;s inviting you needs your internet handle — it&rsquo;s how Buttery finds you.</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-9 items-center rounded-full border-2 border-border bg-muted px-3.5 text-sm font-semibold text-foreground">@{handle}</span>
        <Button size="lg" variant="outline" onClick={onCopy}>
          {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
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

function PasteInviteRow() {
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
    <div>
      <p className="m-0 mb-3 text-[0.9375rem] font-semibold text-foreground">Got a link already?</p>
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
        <Button type="submit" size="lg" variant="secondary" className="mt-3.5">
          <Link2 data-icon="inline-start" aria-hidden="true" />
          Open invite
        </Button>
        {error ? (
          <p id="invite-link-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/**
 * The create panel. Reaching it is already a deliberate choice — the reader had
 * to press a chip — so the submit button is the DEFAULT variant, not the
 * demoted outline the old stacked layout used. The guardrail moves into the copy
 * instead: two half-full pantries cannot be merged later, which is the real cost
 * of creating one when an invite was coming.
 *
 * On this screen the caller has zero memberships, so no second-household confirm
 * is needed here (that lives on the management surface).
 */
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
      await createHousehold(name.trim());
      // Every one of these changes `session.active_household_id` server-side, and
      // better-auth's client store only refetches after its own endpoints — so
      // without this the offline cache partition keeps pointing at the previous
      // household until some later window focus, filing the new household's rows
      // under the old one's buster (offline plan §2.4, §2.7).
      await refreshSession();
      posthog.capture("household_created", { creation_surface: "onboarding" });
      await navigate({ to: "/household" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div>
          <p className="display-title m-0 text-lg leading-tight text-foreground">Name your household</p>
          <p className="mt-1.5 mb-0 text-[0.8125rem] text-pretty text-muted-foreground">
            Only start one if nobody&rsquo;s invited you — two half-full pantries can&rsquo;t be merged later.
          </p>
        </div>

        <form onSubmit={onSubmit}>
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
              <FieldDescription>You can rename it later — nothing here is permanent.</FieldDescription>
            </Field>
          </FieldGroup>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={pending || name.trim() === ""}>
              {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
              {pending ? "Creating…" : "Create a household"}
            </Button>
            <span className="text-[0.8125rem] text-muted-foreground">You&rsquo;ll be the owner. Invite the rest of the house next.</span>
          </div>

          {error ? (
            <p id="household-name-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
