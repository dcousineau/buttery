import React from "react";

/* Badge sits on the SHARED control-height scale (see tokens/spacing.css), so a
 * badge, a button and an input at the same `size` line up exactly. The source
 * app's inline badge is the 24px step — that's `size="xs"` here. */
const CSS = `
.bt-badge{display:inline-flex;width:fit-content;flex-shrink:0;align-items:center;justify-content:center;gap:.375rem;border:2px solid transparent;border-radius:var(--radius-pill);font-family:var(--font-sans);font-weight:600;line-height:1;white-space:nowrap;overflow:hidden;transition:all .12s ease}
.bt-badge>svg{flex-shrink:0;pointer-events:none;width:1em;height:1em}
.bt-badge--default-size{height:var(--control-h);padding:0 var(--control-px);font-size:var(--text-sm)}
.bt-badge--xs{height:var(--control-h-xs);padding:0 var(--control-px-xs);font-size:var(--text-xs);gap:.25rem}
.bt-badge--sm{height:var(--control-h-sm);padding:0 var(--control-px-sm);font-size:var(--text-xs)}
.bt-badge--lg{height:var(--control-h-lg);padding:0 var(--control-px-lg);font-size:var(--text-sm)}
.bt-badge--xl{height:var(--control-h-xl);padding:0 var(--control-px-xl);font-size:var(--text-lg)}
.bt-badge--2xl{height:var(--control-h-2xl);padding:0 var(--control-px-2xl);font-size:var(--text-2xl)}
.bt-badge--default{border-color:var(--border);background:var(--primary);color:var(--primary-foreground)}
.bt-badge--secondary{border-color:var(--border);background:var(--secondary);color:var(--secondary-foreground)}
.bt-badge--destructive{border-color:var(--border);background:color-mix(in oklab,var(--destructive) 10%,transparent);color:var(--destructive)}
.bt-badge--outline{border-color:var(--border);background:var(--card);color:var(--foreground)}
.bt-badge--ghost{background:transparent;color:inherit}
.bt-badge--ghost:hover{background:var(--muted);color:var(--muted-foreground)}
.bt-badge--link{background:transparent;color:var(--primary);text-underline-offset:4px}
.bt-badge--link:hover{text-decoration:underline}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "badge");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

const SIZE_CLASS = {
  xs: "bt-badge--xs",
  sm: "bt-badge--sm",
  default: "bt-badge--default-size",
  lg: "bt-badge--lg",
  xl: "bt-badge--xl",
  "2xl": "bt-badge--2xl",
};

export function Badge({ variant = "default", size = "default", as, className = "", children, ...rest }) {
  inject();
  const Tag = as || "span";
  return (
    <Tag className={["bt-badge", `bt-badge--${variant}`, SIZE_CLASS[size] || SIZE_CLASS.default, className].filter(Boolean).join(" ")} data-slot="badge" {...rest}>
      {children}
    </Tag>
  );
}
