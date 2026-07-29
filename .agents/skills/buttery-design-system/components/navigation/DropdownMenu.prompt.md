The popover menu. Its one production use is the header's household switcher, triggered by an outline button.

```jsx
<DropdownMenu>
  <DropdownMenuTrigger>
    <Button variant="outline" size="sm"><Home />The Cousineau kitchen<ChevronsUpDown /></Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuGroup>
      <DropdownMenuLabel>Active household</DropdownMenuLabel>
      <DropdownMenuItem href="/households">Manage household</DropdownMenuItem>
      <DropdownMenuItem href="/households/switch">Switch household</DropdownMenuItem>
    </DropdownMenuGroup>
    <DropdownMenuSeparator />
    <DropdownMenuItem href="/onboarding">Join or create another</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

Items hover to butter-pale (`--accent`). Destructive items use `variant="destructive"`.
