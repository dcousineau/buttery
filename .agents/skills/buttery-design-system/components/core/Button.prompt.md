The Buttery button — use it for every action; never hand-roll a styled div or anchor for something clickable.

```jsx
<Button>Sign in with atproto</Button>
<Button variant="secondary">Fetch</Button>
<Button variant="outline" size="sm">Rename</Button>
<Button variant="ghost" size="xs">Decline</Button>
<Button variant="destructive" size="sm">Delete household</Button>
<Button as="a" href="/login" variant="link">Learn about internet handles</Button>
```

- `variant="default"` is the Crocker-red primary CTA. One per screen region.
- `variant="secondary"` is butter yellow — brand-accent actions ("Fetch", "Create invite", "Open invite").
- Solid variants carry sticker physics automatically; `ghost` and `link` stay flat by design.
- Labels say what they do ("Save recipe", "Create a household") — never "Get started".
- Icons go inline as children; they're auto-sized to the button's size step.
