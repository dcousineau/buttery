import React from "react";

const CSS = `
.bt-switch{position:relative;display:inline-flex;flex-shrink:0;vertical-align:middle}
.bt-switch-input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:var(--cursor-interactive)}
.bt-switch-input[disabled]{cursor:not-allowed}
.bt-switch-track{display:flex;align-items:center;flex-shrink:0;border:2px solid var(--border);border-radius:var(--radius-pill);background:var(--card);box-shadow:var(--shadow-pop-sm);transition:background .12s ease,box-shadow .12s ease}
.bt-switch-knob{border-radius:50%;background:var(--border);transition:transform .12s ease}
.bt-switch[data-checked=true] .bt-switch-track{background:var(--secondary)}
.bt-switch-input:focus-visible+.bt-switch-track{outline:3px solid var(--ring);outline-offset:2px}
.bt-switch[data-disabled=true]{opacity:.5}
.bt-switch[data-size=sm] .bt-switch-track{width:32px;height:20px;padding:0 2px}
.bt-switch[data-size=sm] .bt-switch-knob{width:12px;height:12px}
.bt-switch[data-size=sm][data-checked=true] .bt-switch-knob{transform:translateX(12px)}
.bt-switch[data-size=default] .bt-switch-track{width:44px;height:24px;padding:0 2px}
.bt-switch[data-size=default] .bt-switch-knob{width:16px;height:16px}
.bt-switch[data-size=default][data-checked=true] .bt-switch-knob{transform:translateX(20px)}
.bt-switch[data-size=lg] .bt-switch-track{width:56px;height:32px;padding:0 3px}
.bt-switch[data-size=lg] .bt-switch-knob{width:22px;height:22px}
.bt-switch[data-size=lg][data-checked=true] .bt-switch-knob{transform:translateX(24px)}
.bt-switch[data-size=xl] .bt-switch-track{width:80px;height:44px;padding:0 4px;box-shadow:var(--shadow-pop)}
.bt-switch[data-size=xl] .bt-switch-knob{width:32px;height:32px}
.bt-switch[data-size=xl][data-checked=true] .bt-switch-knob{transform:translateX(36px)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "switch");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Switch({ size = "default", checked, defaultChecked, onChange, disabled, className = "", style, ...rest }) {
  inject();
  const [internal, setInternal] = React.useState(!!defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? !!checked : internal;
  return (
    <span
      data-slot="switch"
      data-size={size}
      data-checked={on}
      data-disabled={disabled || undefined}
      className={["bt-switch", className].filter(Boolean).join(" ")}
      style={style}
    >
      <input
        type="checkbox"
        role="switch"
        className="bt-switch-input"
        checked={isControlled ? !!checked : undefined}
        defaultChecked={isControlled ? undefined : defaultChecked}
        disabled={disabled}
        onChange={(e) => {
          if (!isControlled) setInternal(e.target.checked);
          onChange?.(e);
        }}
        {...rest}
      />
      <span className="bt-switch-track">
        <span className="bt-switch-knob" />
      </span>
    </span>
  );
}
