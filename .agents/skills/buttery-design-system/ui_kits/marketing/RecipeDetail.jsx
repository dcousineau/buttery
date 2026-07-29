const DSR = window.ButteryDesignSystem_79cab4;

const RECIPE = {
  name: "Brown Butter Skillet Cornbread",
  description: "A cast-iron cornbread with the butter browned first — nutty, craggy edges, honey brushed on hot.",
  by: "@alice.bsky.social",
  app: "recipe.exchange",
  when: "2 days ago",
  uri: "at://did:plc:h3xk2qz7v6ubs4lc/exchange.recipe.recipe/01JMTK16MTE4AVXYSSTGB5B1TR",
  times: [["Prep", "15m"], ["Cook", "30m"], ["Total", "45m"]],
  yield: "8 wedges",
  calories: 260,
  facets: ["American", "Side", "Baked", "vegetarian"],
  keywords: ["cast iron", "cornbread", "weeknight", "potluck"],
  ingredients: [
    "1 cup (140 g) medium-grind cornmeal",
    "1 cup (125 g) all-purpose flour",
    "1 tbsp baking powder",
    "1 tsp fine sea salt",
    "6 tbsp unsalted butter, browned",
    "1 1/4 cups buttermilk",
    "2 large eggs",
    "2 tbsp honey, plus more for brushing",
  ],
  instructions: [
    "Heat the oven to 425°F with a 10-inch cast-iron skillet inside.",
    "Brown the butter in a small pan over medium heat until it smells nutty and the milk solids go amber, about 4 minutes. Set aside.",
    "Whisk the cornmeal, flour, baking powder and salt in a large bowl.",
    "Whisk the buttermilk, eggs and honey together, then stream in the brown butter.",
    "Fold wet into dry until just combined — a few lumps are fine.",
    "Pour into the hot skillet, level the top, and bake 20–24 minutes until the edges pull away and the center springs back.",
    "Brush the top with honey while it's still hot. Cut into wedges in the pan.",
  ],
};

function RecipeDetail({ onNavigate }) {
  const { Button, Badge, Separator } = DSR;
  return (
    <article className="rise-in page-wrap" style={{ padding: "2rem 1rem 4rem" }}>
      <Button variant="ghost" size="sm" onClick={() => onNavigate("landing")} style={{ marginBottom: "1.5rem", marginLeft: "-.5rem" }}>
        <Icon n="arrow-left" />
        Back to the pantry
      </Button>

      <header style={{ display: "grid", gap: "2rem", gridTemplateColumns: "1.1fr 1fr", alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: "0 0 1rem", display: "flex", flexWrap: "wrap", gap: "4px 6px", fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
            <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{RECIPE.by}</span>
            <span>published via <span style={{ fontWeight: 500, color: "var(--foreground)" }}>{RECIPE.app}</span></span>
            <span aria-hidden="true">·</span>
            <span>{RECIPE.when}</span>
          </p>
          <h1 className="display-title" style={{ margin: 0, fontSize: "3rem", lineHeight: 1.08, color: "var(--foreground)" }}>{RECIPE.name}</h1>
          <p style={{ marginTop: "1rem", maxWidth: "60ch", fontSize: "var(--text-lg)", color: "var(--muted-foreground)" }}>{RECIPE.description}</p>

          <div style={{ marginTop: "1.5rem", display: "flex", flexWrap: "wrap", gap: "0.75rem 1.5rem" }}>
            {RECIPE.times.map(([label, value]) => (
              <Stat key={label} icon="clock" label={label} value={value} />
            ))}
            <Stat icon="users" label="Yield" value={RECIPE.yield} />
            <Stat icon="cooking-pot" label="Calories" value={String(RECIPE.calories)} />
          </div>

          <div style={{ marginTop: "1.25rem", display: "flex", flexWrap: "wrap", gap: 8 }}>
            {RECIPE.facets.map((f) => <Badge key={f} variant="outline">{f}</Badge>)}
          </div>
        </div>
        <div>
          <RecipeImage iconSize={56} style={{ border: "2px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-pop-md)" }} />
        </div>
      </header>

      <Separator style={{ margin: "2.5rem 0" }} />

      <div style={{ display: "grid", gap: "2.5rem", gridTemplateColumns: "minmax(0,1fr) 1.6fr" }}>
        <section>
          <h2 className="display-title" style={{ margin: 0, fontSize: "1.5rem", color: "var(--foreground)" }}>Ingredients</h2>
          <ul style={{ margin: "1rem 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: ".625rem" }}>
            {RECIPE.ingredients.map((ing) => (
              <li key={ing} style={{ display: "flex", gap: 12, fontSize: "var(--text-base)", color: "var(--foreground)" }}>
                <span aria-hidden="true" style={{ marginTop: 9, height: 6, width: 6, flexShrink: 0, borderRadius: "50%", background: "var(--primary)" }} />
                <span style={{ minWidth: 0 }}>{ing}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="display-title" style={{ margin: 0, fontSize: "1.5rem", color: "var(--foreground)" }}>Instructions</h2>
          <ol style={{ margin: "1rem 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            {RECIPE.instructions.map((step, i) => (
              <li key={i} style={{ display: "flex", gap: 16 }}>
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    height: 32,
                    width: 32,
                    flexShrink: 0,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "50%",
                    border: "2px solid var(--border)",
                    background: "var(--secondary)",
                    color: "var(--secondary-foreground)",
                    fontSize: "var(--text-sm)",
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </span>
                <p style={{ margin: 0, minWidth: 0, paddingTop: 4, fontSize: "var(--text-base)", lineHeight: 1.625, color: "var(--foreground)" }}>{step}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div style={{ marginTop: "3rem", display: "flex", flexWrap: "wrap", gap: 8 }}>
        {RECIPE.keywords.map((k) => (
          <Badge key={k} variant="ghost" style={{ borderColor: "var(--border)" }}>{k}</Badge>
        ))}
      </div>

      <footer style={{ marginTop: "3rem", borderRadius: "var(--radius-xl)", border: "2px solid var(--border)", background: "color-mix(in oklab, var(--muted) 40%, transparent)", padding: "1.25rem", fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
        <p style={{ margin: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--foreground)" }}>Source: </span>
          <a href="#" style={{ color: "var(--primary)", textDecoration: "underline", textUnderlineOffset: 4 }}>Alice Nakamura</a>
        </p>
        <p style={{ margin: ".5rem 0 0" }}>
          <span style={{ fontWeight: 600, color: "var(--foreground)" }}>Record: </span>
          <code style={{ wordBreak: "break-all" }}>{RECIPE.uri}</code>
        </p>
      </footer>
    </article>
  );
}

function Stat({ icon, label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "var(--muted-foreground)", display: "inline-flex" }}><Icon n={icon} /></span>
      <span style={{ fontSize: "var(--text-sm)" }}>
        <span style={{ fontWeight: 700, color: "var(--foreground)" }}>{value}</span> <span style={{ color: "var(--muted-foreground)" }}>{label}</span>
      </span>
    </div>
  );
}

Object.assign(window, { RecipeDetail });
