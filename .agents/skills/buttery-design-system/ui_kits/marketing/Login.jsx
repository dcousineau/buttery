const DSL = window.ButteryDesignSystem_79cab4;

function Login({ onNavigate, onSignIn }) {
  const { Button, Badge, Card, CardHeader, CardTitle, CardContent, FieldGroup, Field, FieldLabel, Input, Spinner } = DSL;
  const [handle, setHandle] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(null);

  function onSubmit(e) {
    e.preventDefault();
    if (!handle.trim()) {
      setError("Enter your internet handle.");
      return;
    }
    setError(null);
    setPending(true);
    setTimeout(() => onSignIn(handle.trim()), 800);
  }

  return (
    <div className="page-wrap" style={{ padding: "3.5rem 1rem 3rem" }}>
      <div className="rise-in" style={{ margin: "0 auto", display: "flex", maxWidth: "28rem", flexDirection: "column", gap: "1.5rem" }}>
        <header style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <Badge variant="secondary" style={{ marginBottom: ".75rem" }}>Sign in</Badge>
          <h1 className="display-title" style={{ margin: 0, fontSize: "2.25rem", lineHeight: 1.1, color: "var(--foreground)" }}>Welcome to the pantry</h1>
          <p style={{ margin: ".75rem 0 0", fontSize: "var(--text-base)", color: "var(--muted-foreground)" }}>
            Buttery keeps your recipes on <strong style={{ color: "var(--foreground)" }}>your own atproto account</strong> — not our servers. Sign in with your internet handle to
            open your pantry.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ fontSize: "var(--text-xl)" }}>Sign in with your handle</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit}>
              <FieldGroup>
                <Field data-invalid={error ? true : undefined}>
                  <FieldLabel htmlFor="atproto-handle">Internet Handle</FieldLabel>
                  <Input
                    id="atproto-handle"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    placeholder="alice.bsky.social"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={error ? "true" : undefined}
                  />
                </Field>
              </FieldGroup>
              <p style={{ margin: ".5rem 0 0", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
                The handle from your account provider — for most people that's a Bluesky handle like <code>alice.bsky.social</code>.
              </p>
              <Button type="submit" disabled={pending} style={{ marginTop: "1rem" }}>
                {pending ? <Spinner /> : null}
                {pending ? "Redirecting…" : "Sign in with atproto"}
              </Button>
              {error ? (
                <p role="alert" style={{ margin: ".75rem 0 0", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--destructive)" }}>{error}</p>
              ) : null}
            </form>
          </CardContent>
        </Card>

        <Card size="sm" style={{ background: "var(--secondary)", color: "var(--secondary-foreground)" }}>
          <CardHeader>
            <CardTitle className="display-title" style={{ fontSize: "var(--text-lg)" }}>Don't have an account yet?</CardTitle>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "1rem" }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
              Buttery doesn't host accounts — you bring your own. The easiest place to start is a free Bluesky account, which gives you an internet handle that works here.
            </p>
            <Button variant="outline" as="a" href="https://bsky.app" target="_blank" rel="noreferrer">
              Create an account with Bluesky
              <Icon n="external-link" size={14} />
            </Button>
          </CardContent>
        </Card>

        <p style={{ margin: 0, textAlign: "center", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
          New to accounts that work like this?{" "}
          <a href="https://internethandle.org/" target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600, color: "var(--primary)", textDecoration: "underline", textUnderlineOffset: 4 }}>
            Learn about internet handles
            <Icon n="external-link" size={14} />
          </a>
        </p>
      </div>
    </div>
  );
}

Object.assign(window, { Login });
