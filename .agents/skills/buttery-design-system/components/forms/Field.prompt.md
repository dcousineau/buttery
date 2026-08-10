Wrap every input in `Field` inside a `FieldGroup` — this is how all Buttery forms are built.

```jsx
<form onSubmit={onSubmit}>
  <FieldGroup>
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="invite-handle">Handle to invite</FieldLabel>
      <Input id="invite-handle" placeholder="alice.bsky.social" />
    </Field>
  </FieldGroup>
  <FieldDescription>The handle from your account provider.</FieldDescription>
  <Button type="submit" style={{ marginTop: "1rem" }}>Create invite</Button>
</form>
```

Submit buttons sit `1rem` below the group. Errors render as a `role="alert"` paragraph *after* the button, in `var(--destructive)` at weight 600.

A field has **three** states, not two. `data-invalid` is red and blocking — the form will refuse this. `data-warning` is amber and advisory — worth a look, and fine to ignore. Invalid outranks warning, so a field carrying both is drawn red.

```jsx
<Field data-warning={true}>
  <FieldLabel htmlFor="amount">Amount</FieldLabel>
  <Input id="amount" data-warning="true" defaultValue="a splash of milk" />
  <FieldWarning>No amount read — “2 tbsp” helps shopping lists.</FieldWarning>
</Field>
```

`FieldWarning` sits *with* its field (not after the button, the way an error does) and has **no `role="alert"`** — an error interrupts because the form is about to refuse; a warning is a note in the margin. Warning copy is **≤10 words**, names the upside rather than the mistake, and says the fix is optional.
