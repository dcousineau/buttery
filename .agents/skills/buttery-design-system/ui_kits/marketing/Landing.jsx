const DS = window.ButteryDesignSystem_79cab4;

function Landing({ onNavigate }) {
  const { Button, Badge, Card, CardHeader, CardTitle, CardContent, ButterStick, FieldGroup, Field, FieldLabel, Input, Spinner, Separator } = DS;
  const [ref, setRef] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [fetched, setFetched] = React.useState(false);

  function onSubmit(e) {
    e.preventDefault();
    if (!ref.trim()) return;
    setPending(true);
    setTimeout(() => {
      setPending(false);
      setFetched(true);
    }, 700);
  }

  return (
    <div className="page-wrap" style={{ padding: "3.5rem 1rem 2rem" }}>
      <section className="rise-in" style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 420px" }}>
          <Badge variant="secondary" style={{ marginBottom: "1rem" }}>A social recipe box on the open web</Badge>
          <h1 className="display-title" style={{ margin: 0, maxWidth: "42rem", fontSize: "3.75rem", lineHeight: 1.08, color: "var(--foreground)" }}>
            Good recipes,<br />spread <span style={{ color: "var(--primary)" }}>generously.</span>
          </h1>
          <p style={{ marginTop: "1.25rem", maxWidth: "36rem", fontSize: "var(--text-lg)", color: "var(--muted-foreground)" }}>
            <strong style={{ color: "var(--foreground)" }}>but·ter·y</strong> <em>(noun)</em> — a pantry; a room where the good stuff is kept. Buttery keeps your recipes on your own
            atproto account, ready to share with friends — and big and bright on the counter while you cook.
          </p>
          <div style={{ marginTop: "1.5rem", display: "flex", flexWrap: "wrap", gap: 12 }}>
            <Button size="lg" onClick={() => onNavigate("login")}>Sign in with atproto</Button>
            <Button size="lg" variant="outline" as="a" href="#features">What's cooking</Button>
          </div>
        </div>
        <ButterStick label="A pop-art stick of butter" style={{ width: 256, flexShrink: 0, alignSelf: "center" }} />
      </section>

      <div style={{ marginTop: "3rem", display: "grid", gap: "1.5rem", gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))" }}>
        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ fontSize: "var(--text-xl)" }}>Fetch a recipe</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="recipe-ref">Recipe id, recipe.exchange URL, or AT-URI</FieldLabel>
                  <Input id="recipe-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="01JMTK16MTE4AVXYSSTGB5B1TR" />
                </Field>
              </FieldGroup>
              <Button type="submit" variant="secondary" disabled={pending} style={{ marginTop: "1rem" }}>
                {pending ? <Spinner /> : null}
                {pending ? "Fetching…" : "Fetch"}
              </Button>
            </form>
            {fetched ? (
              <article style={{ marginTop: "1.5rem" }}>
                <Separator style={{ marginBottom: "1.25rem" }} />
                <h3 style={{ margin: "0 0 .5rem", fontSize: "var(--text-xl)", fontWeight: 700 }}>Brown Butter Skillet Cornbread</h3>
                <p style={{ margin: "0 0 .25rem", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
                  <code style={{ wordBreak: "break-all" }}>at://did:plc:h3xk2q/recipe.exchange.recipe/01JMTK16MTE4AVXYSSTGB5B1TR</code>
                </p>
                <p style={{ margin: "0 0 1rem", fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
                  A cast-iron cornbread with the butter browned first — nutty, craggy edges, honey brushed on hot.
                </p>
                <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Badge variant="outline">Category: Side</Badge>
                  <Badge variant="outline">Cuisine: American</Badge>
                  <Badge variant="outline">Total: 45m</Badge>
                </div>
              </article>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <RecentRecipes onNavigate={onNavigate} />

      <section id="features" style={{ marginTop: "4rem" }}>
        <h2 className="display-title" style={{ margin: 0, fontSize: "1.875rem", color: "var(--foreground)" }}>What's in the pantry</h2>
        <div style={{ marginTop: "1.5rem", display: "grid", gap: "1.25rem", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
          <FeatureCard icon="cooking-pot" title="Cook mode" highlight blurb="The whole point. Recipes rendered huge and glare-proof for the counter — no sleep, no scrolling with buttery thumbs." />
          <FeatureCard icon="folder-lock" title="Private collections" blurb="Sort recipes into collections only you (or your chosen few) can open." />
          <FeatureCard icon="shopping-basket" title="Shopping lists" blurb="Pick recipes, get one consolidated list for the store." />
          <FeatureCard icon="calendar-range" title="Meal planner" blurb="Lay the week out on the table before it starts." />
          <FeatureCard icon="dices" title="Randomizer" blurb="Can't decide? Roll the dice, dinner picks itself." />
          <FeatureCard icon="book-open-text" title="Yours, portably" blurb="Recipes live in your PDS as atproto records. Leave anytime and take the whole pantry." />
        </div>
      </section>
    </div>
  );
}

const RECENT = [
  { name: "Brown Butter Skillet Cornbread", desc: "Nutty, craggy edges, honey brushed on hot.", by: "@alice.bsky.social", app: "recipe.exchange", when: "2 days ago" },
  { name: "Cold-Oven Pound Cake", desc: "Start it in a cold oven; the crust does the rest.", by: "@marta.recipes", app: "Buttery", when: "4 days ago" },
  { name: "Weeknight Red Lentil Dal", desc: "Twenty minutes, one pot, freezer-friendly.", by: "@dcousineau.com", app: "Buttery", when: "last week" },
];

function RecentRecipes({ onNavigate }) {
  const { Card } = DS;
  return (
    <section style={{ marginTop: "4rem" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "1rem" }}>
        <h2 className="display-title" style={{ margin: 0, fontSize: "1.875rem", color: "var(--foreground)" }}>Fresh from the pantry</h2>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>The latest recipes shared on the network</p>
      </div>
      <div style={{ marginTop: "1.5rem", display: "grid", gap: "1.25rem", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
        {RECENT.map((r) => (
          <Card key={r.name} style={{ padding: 0, cursor: "pointer" }} onClick={() => onNavigate("recipe")}>
            <div style={{ display: "flex", height: "100%", flexDirection: "column" }}>
              <RecipeImage style={{ borderBottom: "2px solid var(--border)" }} />
              <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 8, padding: "1rem" }}>
                <h3 style={{ margin: 0, fontSize: "var(--text-base)", lineHeight: 1.375, fontWeight: 700, color: "var(--foreground)" }}>{r.name}</h3>
                <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>{r.desc}</p>
                <div style={{ marginTop: "auto", paddingTop: 4, display: "flex", flexWrap: "wrap", gap: "4px 6px", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
                  <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{r.by}</span>
                  <span>via <span style={{ fontWeight: 500, color: "var(--foreground)" }}>{r.app}</span></span>
                  <span aria-hidden="true">·</span>
                  <span>{r.when}</span>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ icon, title, blurb, highlight }) {
  const { Card, CardHeader, CardTitle, CardContent, Badge } = DS;
  return (
    <Card style={highlight ? { background: "var(--secondary)", color: "var(--secondary-foreground)" } : undefined}>
      <CardHeader>
        <CardTitle style={{ display: "flex", alignItems: "center", gap: ".625rem", fontWeight: 700 }}>
          <Icon n={icon} size={20} />
          {title}
          {highlight ? (
            <Badge variant="outline" style={{ marginLeft: "auto", fontSize: "0.6rem", letterSpacing: ".05em", textTransform: "uppercase" }}>priority</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: highlight ? "var(--secondary-foreground)" : "var(--muted-foreground)" }}>{blurb}</p>
      </CardContent>
    </Card>
  );
}

Object.assign(window, { Landing });
