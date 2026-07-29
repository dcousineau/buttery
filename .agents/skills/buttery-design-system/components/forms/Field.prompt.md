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
