Transient confirmation for reversible successes. Never for form validation — that stays inline under the field.

```jsx
const { toasts, push, dismiss } = useToasts();

<Button variant="outline" onClick={() => push({ variant: "success", title: "Invite link copied", description: "It's only shown once." })}>
  Copy
</Button>

<ToastViewport>
  {toasts.map((t) => <Toast key={t.id} {...t} onClose={() => dismiss(t.id)} />)}
</ToastViewport>
```

- One line of copy, sentence case, no terminal period on the title.
- `variant="success"` (butter) is the normal case; `destructive` only for a failed background action.
- `size="xl"` in cook mode, bottom-center, so it's legible from the counter.
