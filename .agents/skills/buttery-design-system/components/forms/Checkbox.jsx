import React from "react";

/* Checkbox is the workhorse of Buttery's checklists (ingredients, shopping list,
 * meal-plan assignments). Four size steps: sm/default for dense UI, lg for
 * shopping lists on a phone in a store, xl for cook mode at arm's length.
 *
 * The box and tick are REAL elements, not pseudo-elements, so they survive
 * DOM-rasterised capture (design-system thumbnails, PDF/PPTX export). The native
 * input is present but visually hidden, keeping label/keyboard behaviour intact. */
const CSS = `
.bt-cb{position:relative;display:inline-flex;flex-shrink:0;vertical-align:middle}
.bt-cb-input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:var(--cursor-interactive)}
.bt-cb-input[disabled]{cursor:not-allowed}
.bt-cb-box{display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid var(--border);background:var(--card);box-shadow:var(--shadow-pop-sm);transition:background .1s ease,box-shadow .1s ease,transform .1s ease}
.bt-cb-glyph{width:80%;height:80%;color:var(--secondary-foreground);opacity:0;transform:scale(.6);transition:opacity .1s ease,transform .1s ease}
.bt-cb[data-checked=true] .bt-cb-box,.bt-cb[data-indeterminate=true] .bt-cb-box{background:var(--secondary)}
.bt-cb[data-checked=true] .bt-cb-glyph,.bt-cb[data-indeterminate=true] .bt-cb-glyph{opacity:1;transform:scale(1)}
.bt-cb-input:active+.bt-cb-box{transform:translate(1px,1px);box-shadow:none}
.bt-cb-input:focus-visible+.bt-cb-box{outline:3px solid var(--ring);outline-offset:2px}
.bt-cb[data-disabled=true]{opacity:.5}
/* Radii tighten at the small end: a rounded 16px square reads as a radio. */
.bt-cb[data-size=sm] .bt-cb-box{width:16px;height:16px;border-radius:3px}
.bt-cb[data-size=default] .bt-cb-box{width:20px;height:20px;border-radius:4px}
.bt-cb[data-size=lg] .bt-cb-box{width:28px;height:28px;border-radius:6px}
.bt-cb[data-size=xl] .bt-cb-box{width:40px;height:40px;border-radius:8px;box-shadow:var(--shadow-pop)}

/* Checklist row: the whole row is the hit target, and a checked item strikes through. */
.bt-cb-row{display:flex;width:100%;align-items:center;gap:.75rem;border:2px solid var(--border);border-radius:var(--radius-lg);background:var(--card);color:var(--card-foreground);box-shadow:var(--shadow-pop-sm);text-align:left;font-family:var(--font-sans);transition:background .1s ease,box-shadow .1s ease,transform .1s ease;cursor:var(--cursor-interactive)}
.bt-cb-row:hover{background:var(--accent)}
.bt-cb-row:active{transform:translate(1px,1px);box-shadow:none}
.bt-cb-row[data-checked=true]{background:color-mix(in oklab,var(--muted) 60%,transparent);box-shadow:none}
.bt-cb-row[data-checked=true] .bt-cb-row-label{text-decoration:line-through;text-decoration-thickness:2px;color:var(--muted-foreground)}
.bt-cb-row-label{min-width:0;flex:1}
.bt-cb-row-meta{flex-shrink:0;color:var(--muted-foreground)}
.bt-cb-row--sm{padding:8px 10px;font-size:var(--text-sm)}
.bt-cb-row--default{padding:10px 12px;font-size:var(--text-base)}
.bt-cb-row--lg{padding:14px 16px;font-size:var(--text-lg);gap:1rem}
.bt-cb-row--xl{padding:18px 20px;font-size:var(--text-2xl);gap:1.25rem;border-radius:var(--radius-xl);box-shadow:var(--shadow-pop-md)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "checkbox");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

const TICK = (
  <path d="M20 6 9 17l-5-5" />
);
const DASH = <path d="M5 12h14" />;

export function Checkbox({ size = "default", indeterminate = false, checked, defaultChecked, onChange, disabled, className = "", style, ...rest }) {
  inject();
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? !!checked : internal;
  return (
    <span
      data-slot="checkbox"
      data-size={size}
      data-checked={on}
      data-indeterminate={indeterminate || undefined}
      data-disabled={disabled || undefined}
      className={["bt-cb", className].filter(Boolean).join(" ")}
      style={style}
    >
      <input
        type="checkbox"
        className="bt-cb-input"
        checked={isControlled ? !!checked : undefined}
        defaultChecked={isControlled ? undefined : defaultChecked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : undefined}
        onChange={(e) => {
          if (!isControlled) setInternal(e.target.checked);
          onChange?.(e);
        }}
        {...rest}
      />
      <span className="bt-cb-box">
        <svg className="bt-cb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {indeterminate ? DASH : TICK}
        </svg>
      </span>
    </span>
  );
}

/**
 * A whole-row checklist item — the pattern for ingredients, shopping lists and
 * meal-plan claims. The row is the hit target; a checked row strikes through and
 * drops its shadow so the remaining work stands proud of the done work.
 */
export function CheckboxRow({ size = "default", checked = false, onCheckedChange, meta, className = "", children, ...rest }) {
  inject();
  const boxSize = size === "xl" ? "xl" : size === "lg" ? "lg" : size === "sm" ? "sm" : "default";
  return (
    <label data-slot="checkbox-row" data-checked={checked} className={["bt-cb-row", `bt-cb-row--${size}`, className].filter(Boolean).join(" ")} {...rest}>
      <Checkbox size={boxSize} checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} />
      <span className="bt-cb-row-label">{children}</span>
      {meta ? <span className="bt-cb-row-meta">{meta}</span> : null}
    </label>
  );
}
