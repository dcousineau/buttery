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
  <Field>
    <FieldLabel htmlFor="notes">Notes</FieldLabel>
    <Textarea id="notes" rows={4} placeholder="Doubles well; freeze half the batch." />
  </Field>
</FieldGroup>
```

- **Heights are shared.** `Input`, `Select`, `Button` and `Badge` at the same `size` line up exactly — use one size per row and never hand-tune a height.
- Placeholders show a real example value (`alice.bsky.social`, `The Cousineau kitchen`), never instructions.
- `size="xl"` / `"2xl"` are cook-mode only.
