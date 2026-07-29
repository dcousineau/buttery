const D = window.ButteryDesignSystem_79cab4;
const { Button, Badge, ButterStick, GinghamBand, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } = D;

/** Lucide glyph, rebuilt on every render so React never strips the <svg>. */
function Icon({ n, size = 16, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const host = ref.current;
    if (!host || !window.lucide) return;
    host.innerHTML = "";
    const i = document.createElement("i");
    i.setAttribute("data-lucide", n);
    host.appendChild(i);
    window.lucide.createIcons({ attrs: { width: size, height: size, "stroke-width": 2 } });
  });
  return <span ref={ref} aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, width: size, height: size, ...style }} />;
}

const chromeLink = { color: "var(--muted-foreground)", fontSize: "var(--text-sm)", fontWeight: 600, textDecoration: "none" };

/** Fixed full-width top bar + gingham band. Owns the wordmark. */
function Header({ signedIn, handle, household, onNavigate, onSignOut, leftSlot }) {
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, borderBottom: "2px solid var(--border)", background: "var(--background)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px" }}>
        {leftSlot}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onNavigate(signedIn ? "pantry" : "landing");
          }}
          style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--foreground)", textDecoration: "none" }}
        >
          <ButterStick style={{ height: 24, width: "auto" }} />
          <span className="display-title" style={{ fontSize: "var(--text-lg)", lineHeight: 1 }}>
            Buttery
          </span>
        </a>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {signedIn && household ? (
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="outline" size="sm" style={{ maxWidth: 176 }}>
                  <Icon n="house" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{household}</span>
                  <Icon n="chevrons-up-down" style={{ opacity: 0.7 }} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" style={{ minWidth: "12rem" }}>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Active household</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => onNavigate("household")}>Manage household</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onNavigate("household")}>Switch household</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onNavigate("onboarding")}>Join or create another</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {signedIn ? (
            <>
              <Badge variant="secondary" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
                @{handle}
              </Badge>
              <Button variant="ghost" size="sm" onClick={onSignOut}>
                Sign out
              </Button>
            </>
          ) : (
            <Button onClick={() => onNavigate("login")}>Sign in</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => document.documentElement.classList.toggle("dark")} aria-label="Theme mode: light. Click to switch mode.">
            <Icon n="sun" />
          </Button>
        </div>
      </div>
      <GinghamBand />
    </header>
  );
}

function Footer() {
  return (
    <footer style={{ marginTop: "4rem" }}>
      <GinghamBand />
      <div style={{ borderTop: "2px solid var(--border)", background: "var(--card)", padding: "2rem 1rem 3rem", color: "var(--muted-foreground)" }}>
        <div className="page-wrap" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>© 2026 Buttery — the pantry where the good stuff is kept.</p>
          <nav style={{ display: "flex", flexWrap: "wrap", gap: "0 1rem" }}>
            <a href="#" style={chromeLink}>Terms</a>
            <a href="#" style={chromeLink}>Privacy</a>
            <a href="#" style={chromeLink}>AI Usage</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}

/** The image slot every recipe surface uses when a record has no photo. */
function RecipeImage({ ratio = "4 / 3", iconSize = 40, style }) {
  return (
    <div
      style={{
        aspectRatio: ratio,
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--muted)",
        color: "var(--muted-foreground)",
        ...style,
      }}
    >
      <Icon n="utensils-crossed" size={iconSize} />
    </div>
  );
}

Object.assign(window, { Icon, Header, Footer, RecipeImage, chromeLink });
