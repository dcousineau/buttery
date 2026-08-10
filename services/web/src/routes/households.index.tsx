import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Check, Copy, Crown, Link2, LogOut, Mail, Pencil, Plus, Shield, Trash2, UserMinus, UserPlus, Users } from "lucide-react";
import { useAnalytics } from "#/lib/analytics";
import { requireActiveHousehold, listHouseholdMembers } from "#/server/household/onboarding";
import { listMyHouseholds, renameHousehold, deleteHousehold, createHousehold } from "#/server/household/households";
import { listInvites, createInvite, revokeInvite } from "#/server/household/invites";
import { removeMember, setMemberRole, leaveHousehold } from "#/server/household/members";
import { errorMessage } from "#/server/household/pending-invite";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogClose, DialogTrigger } from "#/components/ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { RadioCard, RadioGroup } from "#/components/ui/radio-group";
import { Select } from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "#/lib/seo";
import type { Role } from "#/server/household/errors";
import type { HouseholdMemberView } from "#/server/household/onboarding";
import type { InviteSummary } from "#/server/household/invites";
import type { FormEvent } from "react";

/** Focus an element via a ref when it becomes `active` — the accessible
 * equivalent of the `autoFocus` prop for fields that appear on an intentional
 * user action (opening an inline editor or a dialog), without tripping
 * `jsx-a11y/no-autofocus`. Pass the flag that gates the field's appearance so
 * focus lands each time it opens. */
function useAutoFocus<T extends HTMLElement>(active: boolean = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
  return ref;
}

/** Household management surface (§7/§10). The loader runs the §8 stale-active
 * guard (`requireActiveHousehold`) so this never renders against a dead/exited
 * household; owner-only data + controls are gated on the caller's server-derived
 * role — the client never decides authorization. */
export const Route = createFileRoute("/households/")({
  loader: async () => {
    const active = await requireActiveHousehold();
    const [members, mine] = await Promise.all([listHouseholdMembers({ data: { householdId: active.householdId } }), listMyHouseholds()]);
    const summary = mine.find((h) => h.id === active.householdId);
    const myRole: Role = summary?.role ?? "member";
    const invites = myRole === "owner" ? await listInvites({ data: { householdId: active.householdId } }) : [];
    return { householdId: active.householdId, name: active.name, myRole, members, invites, householdCount: mine.length };
  },
  head: ({ loaderData }) => ({ meta: seo({ title: loaderData ? `${loaderData.name} · Buttery` : "Household · Buttery", description: "Manage your household." }) }),
  component: HouseholdPage,
});

function HouseholdPage() {
  const data = Route.useLoaderData();
  const isOwner = data.myRole === "owner";
  return (
    <div className="page-wrap px-4 pt-8 pb-12 sm:pt-10">
      <div className="rise-in mx-auto flex max-w-2xl flex-col gap-6">
        <HouseholdHeader householdId={data.householdId} name={data.name} isOwner={isOwner} />

        <MembersSection householdId={data.householdId} members={data.members} isOwner={isOwner} />

        {isOwner ? <InvitesSection householdId={data.householdId} invites={data.invites} /> : null}

        <Separator />

        <CreateAnotherSection currentName={data.name} />

        <DangerZone householdId={data.householdId} isOwner={isOwner} memberCount={data.members.length} />
      </div>
    </div>
  );
}

// --- Header + rename ------------------------------------------------------

function HouseholdHeader({ householdId, name, isOwner }: { householdId: string; name: string; isOwner: boolean }) {
  const router = useRouter();
  const { posthog } = useAnalytics();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusRef = useAutoFocus<HTMLInputElement>(editing);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setError("Give your household a name.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await renameHousehold({ data: { householdId, name: value.trim() } });
      posthog.capture("household_renamed", { household_id: householdId });
      setEditing(false);
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={onSave} className="flex flex-col gap-2">
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="rename-household">Household name</FieldLabel>
            <Input ref={focusRef} id="rename-household" value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} aria-invalid={error ? true : undefined} />
          </Field>
        </FieldGroup>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" aria-hidden="true" />}
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setValue(name);
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
        {error ? (
          <p role="alert" className="m-0 text-sm font-semibold text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <Badge variant="secondary" className="mb-2">
          Household
        </Badge>
        <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">{name}</h1>
      </div>
      {isOwner ? (
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil data-icon="inline-start" aria-hidden="true" />
          Rename
        </Button>
      ) : null}
    </header>
  );
}

// --- Members --------------------------------------------------------------

function MembersSection({ householdId, members, isOwner }: { householdId: string; members: HouseholdMemberView[]; isOwner: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title flex items-center gap-2 text-lg">
          <Users aria-hidden="true" className="size-5" />
          Members ({members.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {members.map((m) => (
          <MemberRow key={m.did} householdId={householdId} member={m} isOwner={isOwner} />
        ))}
      </CardContent>
    </Card>
  );
}

function MemberRow({ householdId, member, isOwner }: { householdId: string; member: HouseholdMemberView; isOwner: boolean }) {
  const router = useRouter();
  const { posthog } = useAnalytics();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  const label = member.handle ? `@${member.handle}` : member.did;

  async function onRemove() {
    // On success the member row unmounts after invalidate; on error `run`
    // surfaces it inline below, so close the dialog either way.
    await run(async () => {
      await removeMember({ data: { householdId, did: member.did } });
      posthog.capture("household_member_removed", { household_id: householdId });
    });
    setRemoveOpen(false);
  }
  // Owner controls apply to OTHER members only; self-management is "Leave" in the
  // danger zone. The last-owner invariant is enforced server-side (LastOwnerError
  // → friendly message surfaced here) — we don't try to predict it in the client.
  const showControls = isOwner && !member.isSelf;

  return (
    <div className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {member.role === "owner" ? <Crown aria-hidden="true" className="size-4 shrink-0 text-primary" /> : null}
          <span className="truncate text-sm font-semibold text-foreground" title={member.did}>
            {label}
          </span>
          {member.isSelf ? (
            <Badge variant="outline" size="xs">
              you
            </Badge>
          ) : null}
          <Badge variant={member.role === "owner" ? "secondary" : "outline"} size="xs">
            {member.role}
          </Badge>
        </div>
        {showControls ? (
          <div className="flex flex-wrap gap-1.5">
            {member.role === "member" ? (
              <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => setMemberRole({ data: { householdId, did: member.did, role: "owner" } }))}>
                <Shield aria-hidden="true" />
                Make owner
              </Button>
            ) : (
              <Button size="xs" variant="outline" disabled={pending} onClick={() => run(() => setMemberRole({ data: { householdId, did: member.did, role: "member" } }))}>
                Make member
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={pending} onClick={() => setRemoveOpen(true)}>
              <UserMinus aria-hidden="true" />
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="m-0 text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this member?"
        description={
          <>
            <strong className="text-foreground">{label}</strong> loses access to this household's shared data. You can invite them back later.
          </>
        }
        confirmLabel="Remove"
        destructive
        pending={pending}
        onConfirm={onRemove}
      />
    </div>
  );
}

// --- Invites (owners) -----------------------------------------------------

function InvitesSection({ householdId, invites }: { householdId: string; invites: InviteSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title flex items-center gap-2 text-lg">
          <Mail aria-hidden="true" className="size-5" />
          Invites
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CreateInviteForm householdId={householdId} invites={invites} />
        <Separator />
        {invites.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No pending invites.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CreateInviteForm({ householdId, invites }: { householdId: string; invites: InviteSummary[] }) {
  const router = useRouter();
  const { posthog } = useAnalytics();
  const [mode, setMode] = useState<"bound" | "open">("bound");
  const [role, setRole] = useState<Role>("member");
  const [handle, setHandle] = useState("");
  const [maxUses, setMaxUses] = useState(5);
  const [expiryDays, setExpiryDays] = useState(7);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The freshly-minted invite: the raw token in `link` is shown ONCE. Keyed by
  // `id` so we can drop the box the moment that invite leaves the list (e.g. it
  // was revoked) rather than dangling a dead link.
  const [created, setCreated] = useState<{ id: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Only show the just-minted link while its invite still exists in the
  // (loader-refreshed) list — revoking it drops the box on the next render.
  // Derived, not an effect, to avoid cascading setState.
  const activeCreated = created && invites.some((i) => i.id === created.id) ? created : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setCopied(false);
    if (mode === "bound" && !handle.trim()) {
      setError("Enter the handle to invite.");
      return;
    }
    setPending(true);
    try {
      const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
      const result = await createInvite({
        data: mode === "bound" ? { householdId, role, boundHandle: handle.trim(), expiresAt } : { householdId, role, maxUses, expiresAt },
      });
      setCreated({ id: result.id, link: result.link });
      posthog.capture("household_invite_created", { household_id: householdId, invite_type: mode, invite_role: role });
      if (mode === "bound") setHandle("");
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function onCopy() {
    if (!activeCreated) return;
    try {
      await navigator.clipboard.writeText(activeCreated.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-2 text-sm font-semibold text-foreground">New invite</legend>
        <RadioGroup orientation="horizontal" aria-label="Invite type">
          <RadioCard
            size="sm"
            name="invite-mode"
            value="bound"
            checked={mode === "bound"}
            onChange={() => setMode("bound")}
            title="Invite a handle"
            description="Locked to one person"
            className="flex-1"
          />
          <RadioCard
            size="sm"
            name="invite-mode"
            value="open"
            checked={mode === "open"}
            onChange={() => setMode("open")}
            title="Shareable link"
            description="Anyone with the link"
            className="flex-1"
          />
        </RadioGroup>
      </fieldset>

      {/* Everything on one line: mode-specific field(s) + role + submit, bottom-aligned. */}
      <div className="flex flex-wrap items-end gap-3">
        {mode === "bound" ? (
          <FieldGroup className="w-64 max-w-full">
            <Field>
              <FieldLabel htmlFor="invite-handle">Handle to invite</FieldLabel>
              <Input
                id="invite-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="alice.bsky.social"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
          </FieldGroup>
        ) : (
          <>
            <FieldGroup className="w-24">
              <Field>
                <FieldLabel htmlFor="invite-max-uses">Max uses</FieldLabel>
                <Input id="invite-max-uses" type="number" min={1} max={100} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
              </Field>
            </FieldGroup>
            <FieldGroup className="w-28">
              <Field>
                <FieldLabel htmlFor="invite-expiry">Expires (days)</FieldLabel>
                <Input id="invite-expiry" type="number" min={1} max={365} value={expiryDays} onChange={(e) => setExpiryDays(Math.max(1, Number(e.target.value) || 1))} />
              </Field>
            </FieldGroup>
          </>
        )}
        <FieldGroup className="w-32">
          <Field>
            <FieldLabel htmlFor="invite-role">Role</FieldLabel>
            <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value === "owner" ? "owner" : "member")}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </Select>
          </Field>
        </FieldGroup>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" aria-hidden="true" />}
          Create invite
        </Button>
      </div>

      {error ? (
        <p role="alert" className="m-0 text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      {activeCreated ? (
        <div className="flex flex-col gap-2 rounded-lg border-2 border-border bg-muted/40 p-3">
          <p className="m-0 flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Link2 aria-hidden="true" className="size-4" />
            Invite link
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={activeCreated.link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" size="sm" variant="outline" onClick={onCopy}>
              {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="m-0 text-xs text-muted-foreground">Share this link with the person you're inviting. It's the only time it's shown.</p>
        </div>
      ) : null}
    </form>
  );
}

function InviteRow({ invite }: { invite: InviteSummary }) {
  const router = useRouter();
  const { posthog } = useAnalytics();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  async function onRevoke() {
    setError(null);
    setPending(true);
    try {
      await revokeInvite({ data: { inviteId: invite.id } });
      posthog.capture("household_invite_revoked", { invite_type: invite.boundToDid ? "bound" : "open", invite_role: invite.role });
      await router.invalidate();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
      setRevokeOpen(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Badge variant={invite.boundToDid ? "outline" : "secondary"} size="xs">
            {invite.boundToDid ? "handle" : "link"}
          </Badge>
          <Badge variant={invite.role === "owner" ? "secondary" : "outline"} size="xs">
            {invite.role}
          </Badge>
          <span className="text-muted-foreground">
            {invite.uses}/{invite.maxUses} used
          </span>
          {invite.expiresAt ? <span className="text-muted-foreground">· expires {invite.expiresAt.slice(0, 10)}</span> : null}
        </div>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => setRevokeOpen(true)}>
          {pending ? <Spinner data-icon="inline-start" /> : <Trash2 aria-hidden="true" />}
          Revoke
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Revoke this invite?"
        description={
          invite.boundToDid
            ? "The invited person won't be able to use it. You can create a new invite anytime."
            : "The shared link stops working immediately, even if you've already sent it. You can create a new one anytime."
        }
        confirmLabel="Revoke"
        destructive
        pending={pending}
        onConfirm={onRevoke}
      />
    </li>
  );
}

// --- Create another (item 11 — deliberately low-emphasis) -----------------

/**
 * Creating a second household is intentionally de-emphasized (§5 guardrail 4):
 * the section is muted body copy with a plain text LINK — no button, no visible
 * form. The link opens a modal that carries the friction copy AND the name input,
 * so the whole flow (nudge → name → confirm) lives behind one deliberate click.
 */
function CreateAnotherSection({ currentName }: { currentName: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusRef = useAutoFocus<HTMLInputElement>(open);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the new household a name.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await createHousehold({ data: { name: name.trim() } });
      setOpen(false);
      // createHousehold sets the new one active server-side; land in it.
      await navigate({ to: "/households" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  // Reset transient state whenever the modal closes so a reopened dialog is clean.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setError(null);
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <section className="flex flex-col gap-1">
        <p className="m-0 text-sm text-muted-foreground">
          Most people only need one household. If you really need a separate space,{" "}
          <DialogTrigger className="font-semibold text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">create another</DialogTrigger>.
        </p>
      </section>

      <DialogContent>
        <DialogTitle>Create another household?</DialogTitle>
        <DialogDescription>
          You're already in <strong className="text-foreground">{currentName}</strong>. Most people only need one — a household is shared with everyone you invite, so you rarely
          need a second.
        </DialogDescription>
        <form onSubmit={onSubmit} className="mt-1 flex flex-col gap-3">
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="new-household-name">New household name</FieldLabel>
              <Input
                ref={focusRef}
                id="new-household-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="The lake house"
                maxLength={100}
                aria-invalid={error ? true : undefined}
              />
            </Field>
          </FieldGroup>
          {error ? (
            <p role="alert" className="m-0 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-1">
            <DialogClose render={<Button type="button" variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
              Create another
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Danger zone ----------------------------------------------------------

function DangerZone({ householdId, isOwner, memberCount }: { householdId: string; isOwner: boolean; memberCount: number }) {
  const navigate = useNavigate();
  const { posthog } = useAnalytics();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    setError(null);
    setPending(true);
    try {
      await leaveHousehold({ data: { householdId } });
      posthog.capture("household_left", { household_id: householdId });
      setLeaveOpen(false);
      await navigate({ to: "/onboarding" });
    } catch (err) {
      setError(errorMessage(err));
      setLeaveOpen(false);
      setPending(false);
    }
  }

  async function onDelete() {
    setError(null);
    setPending(true);
    try {
      await deleteHousehold({ data: { householdId } });
      posthog.capture("household_deleted", { household_id: householdId, member_count: memberCount });
      setDeleteOpen(false);
      await navigate({ to: "/onboarding" });
    } catch (err) {
      setError(errorMessage(err));
      setDeleteOpen(false);
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border-2 border-destructive/30 p-4">
      <h2 className="m-0 text-sm font-semibold text-destructive">Danger zone</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setLeaveOpen(true)}>
          <LogOut data-icon="inline-start" aria-hidden="true" />
          Leave household
        </Button>
        {isOwner ? (
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            Delete household
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="m-0 text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title="Leave this household?"
        description="You'll lose access to its shared data until someone invites you back. If you're the last owner, promote someone else first."
        confirmLabel="Leave"
        destructive
        pending={pending}
        onConfirm={onLeave}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this household?"
        description={`This soft-deletes the household for all ${memberCount} ${memberCount === 1 ? "member" : "members"} and revokes every pending invite. This can't be undone from the app.`}
        confirmLabel="Delete household"
        destructive
        pending={pending}
        onConfirm={onDelete}
      />
    </section>
  );
}
