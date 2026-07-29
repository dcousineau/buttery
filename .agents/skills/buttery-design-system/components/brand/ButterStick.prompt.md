The brand mark. Two sanctioned uses: small in the header lockup, large in a hero or empty state.

```jsx
{/* header lockup */}
<a href="/" style={{ display: "flex", alignItems: "center", gap: ".5rem", color: "var(--foreground)", textDecoration: "none" }}>
  <ButterStick style={{ height: 24, width: "auto" }} />
  <span className="display-title" style={{ fontSize: "var(--text-lg)", lineHeight: 1 }}>Buttery</span>
</a>

{/* hero */}
<ButterStick label="A pop-art stick of butter" style={{ width: "16rem", flexShrink: 0 }} />
```

The mark inherits `--border`, `--butter` and `--butter-deep`, so it re-themes automatically in dark mode; the pale top face is hard-coded `#ffe9a0` on purpose so it stays light on toast. **This mark is a placeholder in the source repo — confirm before using it in anything public.**
