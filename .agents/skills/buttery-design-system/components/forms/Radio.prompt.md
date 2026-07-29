Pick-one controls. Use `RadioCard` whenever the options need explaining; bare `Radio` only for short inline choices.

```jsx
<RadioGroup orientation="horizontal">
  <label style={{display:"flex",alignItems:"center",gap:6}}><Radio name="mode" defaultChecked />Invite a handle</label>
  <label style={{display:"flex",alignItems:"center",gap:6}}><Radio name="mode" />Shareable link</label>
</RadioGroup>

<RadioGroup>
  <RadioCard name="diet" checked={diet==="veg"} onChange={()=>setDiet("veg")}
    title="Vegetarian" description="Hide recipes with meat or fish from the randomizer." />
  <RadioCard name="diet" checked={diet==="gf"} onChange={()=>setDiet("gf")}
    title="Gluten free" description="Also filters wheat-thickened sauces." />
</RadioGroup>
```

A selected `RadioCard` fills butter and grows to `pop-md` — same visual grammar as the active nav item. `size="xl"` for cook mode.
