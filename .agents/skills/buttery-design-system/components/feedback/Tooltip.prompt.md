Ink-filled tooltip for icon-only controls and collapsed sidebar items.

```jsx
<Tooltip content="Collapse sidebar" side="right">
  <Button variant="outline" size="icon-sm"><PanelLeft /></Button>
</Tooltip>
```

Opens with zero delay (matching the app's `TooltipProvider delay={0}`). Never put essential information in a tooltip — cooking-mode controls must never depend on hover.
