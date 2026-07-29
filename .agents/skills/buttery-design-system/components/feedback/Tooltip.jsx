import React from "react";

const CSS = `
.bt-tooltip-wrap{position:relative;display:inline-flex}
.bt-tooltip{position:absolute;z-index:50;display:inline-flex;width:max-content;max-width:20rem;align-items:center;gap:.375rem;border-radius:var(--radius-md);background:var(--foreground);color:var(--background);padding:6px 12px;font-family:var(--font-sans);font-size:var(--text-xs);pointer-events:none;opacity:0;transition:opacity .1s ease}
.bt-tooltip[data-open=true]{opacity:1}
.bt-tooltip[data-side=top]{bottom:calc(100% + 4px);left:50%;transform:translateX(-50%)}
.bt-tooltip[data-side=bottom]{top:calc(100% + 4px);left:50%;transform:translateX(-50%)}
.bt-tooltip[data-side=right]{left:calc(100% + 4px);top:50%;transform:translateY(-50%)}
.bt-tooltip[data-side=left]{right:calc(100% + 4px);top:50%;transform:translateY(-50%)}
.bt-tooltip-arrow{position:absolute;width:10px;height:10px;background:var(--foreground);transform:rotate(45deg);border-radius:2px}
.bt-tooltip[data-side=top] .bt-tooltip-arrow{bottom:-3px;left:50%;margin-left:-5px}
.bt-tooltip[data-side=bottom] .bt-tooltip-arrow{top:-3px;left:50%;margin-left:-5px}
.bt-tooltip[data-side=right] .bt-tooltip-arrow{left:-3px;top:50%;margin-top:-5px}
.bt-tooltip[data-side=left] .bt-tooltip-arrow{right:-3px;top:50%;margin-top:-5px}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "tooltip");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Tooltip({ content, side = "top", className = "", children, ...rest }) {
  inject();
  const [open, setOpen] = React.useState(false);
  return (
    <span
      className={["bt-tooltip-wrap", className].filter(Boolean).join(" ")}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      {...rest}
    >
      {children}
      <span role="tooltip" data-slot="tooltip-content" data-open={open} data-side={side} className="bt-tooltip">
        {content}
        <span className="bt-tooltip-arrow" aria-hidden="true" />
      </span>
    </span>
  );
}
