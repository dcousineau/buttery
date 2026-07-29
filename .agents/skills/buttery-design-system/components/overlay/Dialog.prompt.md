Centered modal. `ConfirmDialog` is the packaged form used for every destructive or high-friction decision.

```jsx
<ConfirmDialog
  open={leaveOpen}
  onOpenChange={setLeaveOpen}
  title="Leave this household?"
  description="You'll lose access to its shared data until someone invites you back."
  confirmLabel="Leave"
  destructive
  onConfirm={onLeave}
/>
```

- Titles are questions ending in "?" and use the display font.
- Confirm labels restate the verb ("Leave", "Delete household", "Create another") — never "OK" / "Yes".
- Cancel is always `variant="ghost"` on the left of the confirm.
- Use a bare `Dialog` when the modal contains a form (the "create another household" flow).
