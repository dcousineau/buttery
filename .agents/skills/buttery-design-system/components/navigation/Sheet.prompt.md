Slide-in edge panel. Its production job is the mobile nav drawer; use `side="left"` for that.

```jsx
<Sheet open={open} onOpenChange={setOpen} side="left" style={{ width: "18rem", background: "var(--sidebar)" }}>
  <SidebarContent>…</SidebarContent>
</Sheet>
```

Overlay is `rgba(0,0,0,.1)` — deliberately lighter than the dialog backdrop, because the drawer is navigation, not a decision.
