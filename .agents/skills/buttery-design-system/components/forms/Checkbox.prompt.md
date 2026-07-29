Checkboxes and checklist rows — the highest-traffic control in Buttery (ingredients, shopping lists, meal-plan claims).

```jsx
{/* dense form use */}
<Field orientation="horizontal"><Checkbox id="pub" /><FieldLabel htmlFor="pub">Publish to atproto</FieldLabel></Field>

{/* shopping list */}
<CheckboxRow size="lg" checked={done} onCheckedChange={setDone} meta="2 cups">Medium-grind cornmeal</CheckboxRow>

{/* cook mode */}
<CheckboxRow size="xl" checked={done} onCheckedChange={setDone} meta="6 tbsp">Unsalted butter, browned</CheckboxRow>

{/* an aisle group with some items done */}
<Checkbox size="lg" indeterminate />
```

- Use `CheckboxRow` for lists, bare `Checkbox` only inside a form field.
- `size="xl"` is reserved for cook mode / kiosk surfaces (≥44px hit target, 1.5rem label).
- Checked rows strike through and go flat — done work recedes, remaining work keeps its shadow.
