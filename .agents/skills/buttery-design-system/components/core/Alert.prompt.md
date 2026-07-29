A quiet inline notice — 1px border, no shadow — for information that belongs beside content rather than on top of it.

```jsx
<Alert>
  <Info />
  <AlertTitle>Recipes live in your PDS</AlertTitle>
  <AlertDescription>Leave anytime and take the whole pantry.</AlertDescription>
</Alert>
<Alert variant="destructive"><AlertTitle>Sign-in was not completed.</AlertTitle></Alert>
```

Form validation in Buttery does NOT use Alert — it uses a `role="alert"` paragraph in `var(--destructive)` at `font-weight: 600` under the submit button. Reserve Alert for standing notices.
