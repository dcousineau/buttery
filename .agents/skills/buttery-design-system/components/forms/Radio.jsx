import React from "react";

/* Dot and knob are real elements (not pseudo-elements) so they survive
 * DOM-rasterised capture — see Checkbox.jsx for the same reasoning. */
const CSS = `
.bt-rg{display:flex;flex-direction:column;gap:.5rem}
.bt-rg[data-orientation=horizontal]{flex-direction:row;flex-wrap:wrap;gap:1rem;align-items:center}
.bt-radio{position:relative;display:inline-flex;flex-shrink:0;vertical-align:middle}
.bt-radio-input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:var(--cursor-interactive)}
.bt-radio-input[disabled]{cursor:not-allowed}
.bt-radio-box{display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid var(--border);border-radius:50%;background:var(--card);box-shadow:var(--shadow-pop-sm);transition:background .1s ease,box-shadow .1s ease,transform .1s ease}
.bt-radio-dot{width:46%;height:46%;border-radius:50%;background:var(--secondary-foreground);opacity:0;transform:scale(.4);transition:opacity .1s ease,transform .1s ease}
.bt-radio[data-checked=true] .bt-radio-box{background:var(--secondary)}
.bt-radio[data-checked=true] .bt-radio-dot{opacity:1;transform:scale(1)}
.bt-radio-input:active+.bt-radio-box{transform:translate(1px,1px);box-shadow:none}
.bt-radio-input:focus-visible+.bt-radio-box{outline:3px solid var(--ring);outline-offset:2px}
.bt-radio[data-disabled=true]{opacity:.5}
.bt-radio[data-size=sm] .bt-radio-box{width:16px;height:16px}
.bt-radio[data-size=default] .bt-radio-box{width:20px;height:20px}
.bt-radio[data-size=lg] .bt-radio-box{width:28px;height:28px}
.bt-radio[data-size=xl] .bt-radio-box{width:40px;height:40px;box-shadow:var(--shadow-pop)}

/* Selectable card: the "pick one" pattern for diets, portion sizes, invite modes. */
.bt-radio-card{display:flex;align-items:flex-start;gap:.75rem;border:2px solid var(--border);border-radius:var(--radius-lg);background:var(--card);color:var(--card-foreground);box-shadow:var(--shadow-pop-sm);font-family:var(--font-sans);text-align:left;transition:background .1s ease,box-shadow .1s ease,transform .1s ease;cursor:var(--cursor-interactive)}
.bt-radio-card:hover{background:var(--accent)}
.bt-radio-card:active{transform:translate(1px,1px);box-shadow:none}
.bt-radio-card[data-checked=true]{background:var(--secondary);color:var(--secondary-foreground);box-shadow:var(--shadow-pop-md)}
.bt-radio-card--sm{padding:8px 10px;font-size:var(--text-sm)}
.bt-radio-card--default{padding:12px 14px;font-size:var(--text-base)}
.bt-radio-card--lg{padding:16px 18px;font-size:var(--text-lg)}
.bt-radio-card--xl{padding:20px 24px;font-size:var(--text-2xl);gap:1.25rem;border-radius:var(--radius-xl);box-shadow:var(--shadow-pop-md)}
.bt-radio-card-title{font-weight:600}
.bt-radio-card-desc{margin:.125rem 0 0;font-size:.875em;color:var(--muted-foreground)}
.bt-radio-card[data-checked=true] .bt-radio-card-desc{color:var(--secondary-foreground);opacity:.8}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "radio");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function RadioGroup({ orientation = "vertical", className = "", children, ...rest }) {
  inject();
  return (
    <div role="radiogroup" data-slot="radio-group" data-orientation={orientation} className={["bt-rg", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function Radio({ size = "default", checked, defaultChecked, onChange, disabled, className = "", style, ...rest }) {
  inject();
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? !!checked : internal;
  return (
    <span
      data-slot="radio"
      data-size={size}
      data-checked={on}
      data-disabled={disabled || undefined}
      className={["bt-radio", className].filter(Boolean).join(" ")}
      style={style}
    >
      <input
        type="radio"
        className="bt-radio-input"
        checked={isControlled ? !!checked : undefined}
        defaultChecked={isControlled ? undefined : defaultChecked}
        disabled={disabled}
        onChange={(e) => {
          if (!isControlled) setInternal(e.target.checked);
          onChange?.(e);
        }}
        {...rest}
      />
      <span className="bt-radio-box">
        <span className="bt-radio-dot" />
      </span>
    </span>
  );
}

export function RadioCard({ size = "default", checked = false, name, value, onChange, title, description, className = "", children, ...rest }) {
  inject();
  const boxSize = size === "xl" ? "xl" : size === "lg" ? "lg" : size === "sm" ? "sm" : "default";
  return (
    <label data-slot="radio-card" data-checked={checked} className={["bt-radio-card", `bt-radio-card--${size}`, className].filter(Boolean).join(" ")} {...rest}>
      <Radio size={boxSize} name={name} value={value} checked={checked} onChange={onChange} />
      <span style={{ minWidth: 0 }}>
        <span className="bt-radio-card-title">{title}</span>
        {description ? <p className="bt-radio-card-desc">{description}</p> : null}
        {children}
      </span>
    </label>
  );
}
