const DSA = window.ButteryDesignSystem_79cab4;

const NAV = [
  ["Home", "house", "pantry"],
  ["Recipes", "book-open-text", null],
  ["Collections", "folder-lock", null],
  ["Shopping list", "shopping-basket", null],
  ["Meal planner", "calendar-range", null],
  ["Randomizer", "dices", null],
];

function AppNav({ screen, onNavigate }) {
  const { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuBadge } = DSA;
  return (
    <Sidebar style={{ position: "sticky", top: 0, alignSelf: "flex-start", height: "calc(100vh - 74px)" }}>
      <SidebarContent style={{ paddingTop: ".5rem" }}>
        <SidebarGroup>
          <SidebarGroupLabel>The pantry</SidebarGroupLabel>
          <SidebarMenu>
            {NAV.map(([label, icon, target]) => (
              <SidebarMenuItem key={label}>
                <SidebarMenuButton
                  isActive={target === screen}
                  aria-disabled={target ? undefined : "true"}
                  onClick={target ? () => onNavigate(target) : undefined}
                >
                  <Icon n={icon} />
                  <span>{label}</span>
                </SidebarMenuButton>
                {target ? null : (
                  <SidebarMenuBadge style={{ fontSize: "0.6rem", letterSpacing: ".05em", textTransform: "uppercase" }}>soon</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function PantryHome({ household, onNavigate }) {
  const { Button, Badge, Card, CardHeader, CardTitle, CardContent } = DSA;
  return (
    <div className="page-wrap" style={{ padding: "3.5rem 1rem 3rem" }}>
      <div className="rise-in" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <header style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <Badge variant="secondary" style={{ marginBottom: ".75rem" }}>{household}</Badge>
          <h1 className="display-title" style={{ margin: 0, fontSize: "2.25rem", lineHeight: 1.1, color: "var(--foreground)" }}>Your pantry</h1>
          <p style={{ margin: ".75rem 0 0", maxWidth: "36rem", fontSize: "var(--text-base)", color: "var(--muted-foreground)" }}>
            This is the home for <strong style={{ color: "var(--foreground)" }}>{household}</strong>. It'll become your overview — recent recipes, shelves, and what's on the menu —
            as those features land. For now, the shelves are still being stocked.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="display-title" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-lg)" }}>
              <Icon n="compass" size={20} />
              Overview coming soon
            </CardTitle>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "1rem" }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted-foreground)" }}>
              Once recipes, collections, and the meal planner are live, this page will pull them together at a glance.
            </p>
            <Button variant="outline" onClick={() => onNavigate("household")}>
              <Icon n="settings-2" />
              Manage household
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

Object.assign(window, { AppNav, PantryHome });
