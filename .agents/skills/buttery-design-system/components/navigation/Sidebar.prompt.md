The app's left nav rail. Its group label is literally "The pantry".

```jsx
<Sidebar>
  <SidebarContent style={{ paddingTop: ".5rem" }}>
    <SidebarGroup>
      <SidebarGroupLabel>The pantry</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton href="/pantry" isActive><Home /><span>Home</span></SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton aria-disabled="true"><BookOpenText /><span>Recipes</span></SidebarMenuButton>
          <SidebarMenuBadge>soon</SidebarMenuBadge>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  </SidebarContent>
</Sidebar>
```

- Unbuilt features stay VISIBLE but non-interactive with a lowercase `soon` badge (uppercase via CSS, 0.6rem, letter-spaced). This is a deliberate roadmap-in-the-nav choice.
- Nav order: Home, Recipes, Collections, Shopping list, Meal planner, Randomizer.
- The rail is fixed below the header and becomes a left `Sheet` drawer below 768px.
