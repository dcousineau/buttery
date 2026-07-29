import React from "react";

const CSS = `
.bt-alert{position:relative;display:grid;width:100%;gap:.125rem;border:1px solid var(--border);border-radius:var(--radius-lg);padding:8px 10px;text-align:left;font-size:var(--text-sm);background:var(--card);color:var(--card-foreground)}
.bt-alert:has(>svg){grid-template-columns:auto 1fr;column-gap:.5rem}
.bt-alert>svg{grid-row:span 2;width:1rem;height:1rem;transform:translateY(2px);color:currentColor}
.bt-alert--destructive{color:var(--destructive)}
.bt-alert--destructive .bt-alert-description{color:color-mix(in oklab,var(--destructive) 90%,transparent)}
.bt-alert-title{font-weight:500}
.bt-alert:has(>svg) .bt-alert-title{grid-column-start:2}
.bt-alert-description{font-size:var(--text-sm);color:var(--muted-foreground)}
.bt-alert-action{position:absolute;top:8px;right:8px}
.bt-alert:has(.bt-alert-action){padding-right:4.5rem}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "alert");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Alert({ variant = "default", className = "", children, ...rest }) {
  inject();
  return (
    <div role="alert" data-slot="alert" className={["bt-alert", `bt-alert--${variant}`, className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function AlertTitle({ className = "", children, ...rest }) {
  return (
    <div data-slot="alert-title" className={["bt-alert-title", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function AlertDescription({ className = "", children, ...rest }) {
  return (
    <div data-slot="alert-description" className={["bt-alert-description", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function AlertAction({ className = "", children, ...rest }) {
  return (
    <div data-slot="alert-action" className={["bt-alert-action", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
