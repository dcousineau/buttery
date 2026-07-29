Collapsible stacked sections. Each item is its own bordered card, so an open panel reads as a lifted sticker.

```jsx
<Accordion defaultOpen={["stage-1"]}>
  <AccordionItem value="stage-1">
    <AccordionTrigger>Brown the butter</AccordionTrigger>
    <AccordionContent>Melt over medium until it smells nutty and the solids go amber, about 4 minutes.</AccordionContent>
  </AccordionItem>
  <AccordionItem value="stage-2">
    <AccordionTrigger>Mix and bake</AccordionTrigger>
    <AccordionContent>Fold wet into dry, pour into the hot skillet, bake 20–24 minutes.</AccordionContent>
  </AccordionItem>
</Accordion>
```

- Default is `type="multiple"` — a cook keeps more than one stage open. Use `single` for FAQ/settings.
- `size="xl"` for cook mode. The chevron rotates 90°, it never flips.
