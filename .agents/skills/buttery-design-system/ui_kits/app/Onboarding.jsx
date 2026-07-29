const DSO = window.ButteryDesignSystem_79cab4;

function Onboarding({ onNavigate }) {
  const { Button, Badge, Card, CardHeader, CardTitle, CardContent, Separator, FieldGroup, Field, FieldLabel, Input, Spinner } = DSO;
  const [invites, setInvites] = React.useState([{ id: "1", household: "The Cousineau kitchen", inviter: "dcousineau.com", role: "member" }]);
  const [pending, setPending] = React.useState(null);

  function accept(id) {
    setPending(id);
    setTimeout(() => {
      setPending(null);
      onNavigate("household");
    }, 700);
  }

  return (
    <div className="page-wrap" style={{ padding: "3.5rem 1rem 3rem" }}>
      <div className="rise-in" style={{ margin: "0 auto", display: "flex", maxWidth: "36rem", flexDirection: "column", gap: "1.5rem" }}>
        <header style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <Badge variant="secondary" style={{ marginBottom: ".75rem" }}>Get started</Badge>
          <h1 className="display-title" style={{ margin: 0, fontSize: "2.25rem", lineHeight: 1.1, color: "var(--foreground)" }}>Join a household</h1>
          <p style={{ margin: ".75rem 0 0", fontSize: "var(--text-base)", color: "var(--muted-foreground)" }}>
            A <strong style={{ color: "var(--foreground)" }}>household</strong> is your private, shared space in Buttery. Most people join one someone else already set up — if
            you're expecting an invite, hold tight and it'll show up right here.
          </p>
        </header>

        {invites.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 className="display-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-lg)", color: "var(--foreground)" }}>
              <Icon n="mail" size={20} />
              Your invitations
            </h2>
            {invites.map((inv) => (
              <Card key={inv.id}>
                <CardContent style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: "var(--text-base)", fontWeight: 700, color: "var(--foreground)" }}>{inv.household}</p>
                      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>Invited by @{inv.inviter}</p>
                    </div>
                    <Badge variant="outline">{inv.role}</Badge>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <Button onClick={() => accept(inv.id)} disabled={pending !== null}>
                      {pending === inv.id ? <Spinner /> : null}
                      Accept invite
                    </Button>
                    <Button variant="ghost" disabled={pending !== null} onClick={() => setInvites([])}>Decline</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </section>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="display-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-lg)" }}>
                <Icon n="mail-question" size={20} />
                No invitations yet
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
                When someone invites you to their household, it'll appear here for you to accept. Waiting for an invite is the easiest way in — you don't need to create anything
                yourself.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ fontSize: "var(--text-lg)" }}>Have an invite link?</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => e.preventDefault()}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="invite-link">Paste your invite link</FieldLabel>
                  <Input id="invite-link" placeholder="https://buttery.recipes/invite/…" autoCapitalize="none" spellCheck={false} />
                </Field>
              </FieldGroup>
              <Button type="submit" variant="secondary" style={{ marginTop: "1rem" }}>Open invite</Button>
            </form>
          </CardContent>
        </Card>

        <Separator />

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--muted-foreground)" }}>Starting fresh?</h2>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
            If nobody's invited you yet, you can create your own household. Most people only ever need one — you can always invite others once it exists.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); onNavigate("household"); }} style={{ marginTop: 8 }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="household-name">Household name</FieldLabel>
                <Input id="household-name" placeholder="The Cousineau kitchen" maxLength={100} />
              </Field>
            </FieldGroup>
            <Button type="submit" variant="outline" style={{ marginTop: "1rem" }}><Icon n="plus" size={14} />Create a household</Button>
          </form>
        </section>
      </div>
    </div>
  );
}

Object.assign(window, { Onboarding });
