Text entry. Always wrapped in a `Field` with a `FieldLabel` — never a bare input with placeholder-as-label.

```jsx
<FieldGroup>
  <Field data-invalid={error ? true : undefined}>
    <FieldLabel htmlFor="atproto-handle">Internet Handle</FieldLabel>
    <Input id="atproto-handle" placeholder="alice.bsky.social" aria-invalid={error || undefined} />
  </Field>
  <Field>
    <FieldLabel htmlFor="role">Role</FieldLabel>
    <Select id="role"><option>Member</option><option>Owner</option></Select>
  </Field>
  <Field data-warning={true}>
    <FieldLabel htmlFor="amount">Amount</FieldLabel>
    <Input id="amount" data-warning="true" defaultValue="a splash of milk" />
    <FieldWarning>No amount read — “2 tbsp” helps shopping lists.</FieldWarning>
  </Field>
  <Field>
    <FieldLabel htmlFor="notes">Notes</FieldLabel>
    <Textarea id="notes" rows={4} placeholder="Doubles well; freeze half the batch." />
  </Field>
</FieldGroup>
```

- **Heights are shared.** `Input`, `Select`, `Button` and `Badge` at the same `size` line up exactly — use one size per row and never hand-tune a height.
- Placeholders show a real example value (`alice.bsky.social`, `The Cousineau kitchen`), never instructions.
- `size="xl"` / `"2xl"` are cook-mode only.
- **Three problem states, not two.** `aria-invalid` is red and blocking ("this will not save"); `data-warning="true"` is amber and advisory ("worth a look, fine to ignore"). Set one, never both — if both land on a control, invalid wins and the amber is suppressed.
- Reach for warning when the app is guessing on the user's behalf: an ingredient with no readable amount, a step mentioning a time we couldn't parse. Those records save perfectly well, and painting them red teaches people that red means nothing.
- `data-warning` sets **no ARIA** — `aria-invalid` on something that saves fine lies to a screen reader. It's a colour; `FieldWarning` carries the words.
