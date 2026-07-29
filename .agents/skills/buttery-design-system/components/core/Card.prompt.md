The paper surface every block of Buttery content sits on — forms, feature blurbs, recipe tiles, member lists.

```jsx
<Card>
  <CardHeader>
    <CardTitle className="display-title" style={{ fontSize: "var(--text-xl)" }}>Fetch a recipe</CardTitle>
  </CardHeader>
  <CardContent>…</CardContent>
</Card>
```

- Card titles that are *page-level moments* add `className="display-title"`; ordinary card titles stay Rubik 500.
- The sanctioned color override is a butter highlight card: `style={{ background: "var(--secondary)", color: "var(--secondary-foreground)" }}` (landing FeatureCard, "Don't have an account yet?").
- Recipe cards put a 4:3 `<img>` first with a `border-bottom: 2px solid var(--border)`, then a padded text block; the whole card lifts 2px on hover.
- Never add a blurred shadow or a gradient. `size="sm"` for dense/aside cards.
