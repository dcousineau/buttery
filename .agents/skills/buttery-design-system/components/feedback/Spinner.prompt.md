Inline loading glyph — always inside the pending button, next to a changed label.

```jsx
<Button type="submit" disabled={pending}>
  {pending ? <Spinner /> : null}
  {pending ? "Redirecting…" : "Sign in with atproto"}
</Button>
```

Buttery pairs the spinner with a present-progressive label ending in an ellipsis character (`…`, not three dots). There is no full-page loading spinner.
