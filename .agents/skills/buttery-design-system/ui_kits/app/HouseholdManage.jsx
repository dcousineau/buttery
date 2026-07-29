const DSH = window.ButteryDesignSystem_79cab4;

const MEMBERS = [
  { handle: "dcousineau.com", role: "owner", isSelf: true },
  { handle: "marta.recipes", role: "owner", isSelf: false },
  { handle: "alice.bsky.social", role: "member", isSelf: false },
];

function HouseholdManage({ household }) {
  const { Button, Badge, Card, CardHeader, CardTitle, CardContent, Separator, FieldGroup, Field, FieldLabel, Input, NativeSelect, ConfirmDialog, FieldSet, FieldLegend } = DSH;
  const [name, setName] = React.useState(household);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(household);
  const [mode, setMode] = React.useState("bound");
  const [link, setLink] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [leaveOpen, setLeaveOpen] = React.useState(false);

  return (
    <div className="page-wrap" style={{ padding: "2.5rem 1rem 3rem" }}>
      <div className="rise-in" style={{ margin: "0 auto", display: "flex", maxWidth: "42rem", flexDirection: "column", gap: "1.5rem" }}>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setName(draft);
              setEditing(false);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="rename">Household name</FieldLabel>
                <Input id="rename" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={100} />
              </Field>
            </FieldGroup>
            <div style={{ display: "flex", gap: 8 }}>
              <Button type="submit" size="sm"><Icon n="check" size={14} />Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft(name); setEditing(false); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <Badge variant="secondary" style={{ marginBottom: ".5rem" }}>Household</Badge>
              <h1 className="display-title" style={{ margin: 0, fontSize: "2.25rem", lineHeight: 1.1, color: "var(--foreground)" }}>{name}</h1>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Icon n="pencil" size={14} />Rename</Button>
          </header>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-lg)" }}>
              <Icon n="users" size={20} />
              Members ({MEMBERS.length})
            </CardTitle>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {MEMBERS.map((m) => (
              <div key={m.handle} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: "1px solid color-mix(in oklab, var(--border) 60%, transparent)" }}>
                <div style={{ display: "flex", minWidth: 0, alignItems: "center", gap: 8 }}>
                  {m.role === "owner" ? <span style={{ color: "var(--primary)", display: "inline-flex" }}><Icon n="crown" size={14} /></span> : null}
                  <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--foreground)" }}>@{m.handle}</span>
                  {m.isSelf ? <Badge variant="outline" style={{ fontSize: "0.65rem" }}>you</Badge> : null}
                  <Badge variant={m.role === "owner" ? "secondary" : "outline"}>{m.role}</Badge>
                </div>
                {m.isSelf ? null : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <Button size="xs" variant="outline">{m.role === "member" ? <><Icon n="shield" size={12} />Make owner</> : "Make member"}</Button>
                    <Button size="xs" variant="ghost"><Icon n="user-minus" size={12} />Remove</Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-lg)" }}>
              <Icon n="mail" size={20} />
              Invites
            </CardTitle>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setLink("https://buttery.recipes/invite/6f2a91c4e8b7d05a");
                setCopied(false);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <FieldSet>
                <FieldLegend>New invite</FieldLegend>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)" }}>
                    <input type="radio" name="invite-mode" checked={mode === "bound"} onChange={() => setMode("bound")} />
                    Invite a handle
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)" }}>
                    <input type="radio" name="invite-mode" checked={mode === "open"} onChange={() => setMode("open")} />
                    Shareable link
                  </label>
                </div>
              </FieldSet>

              {mode === "bound" ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="invite-handle">Handle to invite</FieldLabel>
                    <Input id="invite-handle" placeholder="alice.bsky.social" autoCapitalize="none" spellCheck={false} />
                  </Field>
                </FieldGroup>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                  <FieldGroup style={{ width: 112 }}>
                    <Field><FieldLabel htmlFor="max-uses">Max uses</FieldLabel><Input id="max-uses" type="number" defaultValue={5} /></Field>
                  </FieldGroup>
                  <FieldGroup style={{ width: 128 }}>
                    <Field><FieldLabel htmlFor="expiry">Expires (days)</FieldLabel><Input id="expiry" type="number" defaultValue={7} /></Field>
                  </FieldGroup>
                </div>
              )}

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
                <FieldGroup style={{ width: 160 }}>
                  <Field><FieldLabel htmlFor="role">Role</FieldLabel><NativeSelect id="role"><option>Member</option><option>Owner</option></NativeSelect></Field>
                </FieldGroup>
                <Button type="submit" size="sm" variant="secondary"><Icon n="user-plus" size={14} />Create invite</Button>
              </div>

              {link ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, borderRadius: "var(--radius-lg)", border: "2px solid var(--border)", background: "color-mix(in oklab, var(--muted) 40%, transparent)", padding: 12 }}>
                  <p style={{ margin: 0, display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--foreground)" }}>
                    <Icon n="link-2" size={14} />
                    Invite link
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Input readOnly value={link} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }} />
                    <Button type="button" size="sm" variant="outline" onClick={() => setCopied(true)}>
                      <Icon n={copied ? "check" : "copy"} size={14} />
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>Share this link with the person you're inviting. It's the only time it's shown.</p>
                </div>
              ) : null}
            </form>

            <Separator />

            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
              <li style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 0" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: "var(--text-sm)" }}>
                  <Badge variant="outline">handle</Badge>
                  <Badge variant="outline">member</Badge>
                  <span style={{ color: "var(--muted-foreground)" }}>0/1 used</span>
                  <span style={{ color: "var(--muted-foreground)" }}>· expires 2026-08-12</span>
                </div>
                <Button size="xs" variant="ghost"><Icon n="trash-2" size={12} />Revoke</Button>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Separator />

        <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
            Most people only need one household. If you really need a separate space,{" "}
            <button type="button" style={{ background: "none", border: 0, padding: 0, font: "inherit", fontWeight: 600, color: "var(--muted-foreground)", textDecoration: "underline dotted", textUnderlineOffset: 4 }}>create another</button>.
          </p>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 12, borderRadius: "var(--radius-xl)", border: "2px solid color-mix(in oklab, var(--destructive) 30%, transparent)", padding: "1rem" }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--destructive)" }}>Danger zone</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button variant="outline" size="sm" onClick={() => setLeaveOpen(true)}><Icon n="log-out" size={14} />Leave household</Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}><Icon n="trash-2" size={14} />Delete household</Button>
          </div>
        </section>

        <ConfirmDialog
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
          onConfirm={() => setLeaveOpen(false)}
          destructive
          title="Leave this household?"
          description="You'll lose access to its shared data until someone invites you back. If you're the last owner, promote someone else first."
          confirmLabel="Leave"
        />
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => setDeleteOpen(false)}
          destructive
          title="Delete this household?"
          description="This soft-deletes the household for all 3 members and revokes every pending invite. This can't be undone from the app."
          confirmLabel="Delete household"
        />
      </div>
    </div>
  );
}

Object.assign(window, { HouseholdManage });
