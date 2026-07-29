import React from "react";

const CSS = `
.bt-card{--bt-card-spacing:1rem;display:flex;flex-direction:column;gap:var(--bt-card-spacing);overflow:hidden;border:2px solid var(--border);border-radius:var(--radius-xl);background:var(--card);color:var(--card-foreground);padding-block:var(--bt-card-spacing);font-size:var(--text-sm);box-shadow:var(--shadow-pop-md)}
.bt-card[data-size=sm]{--bt-card-spacing:.75rem}
.bt-card[data-size=lg]{--bt-card-spacing:1.5rem;font-size:var(--text-base)}
.bt-card[data-size=xl]{--bt-card-spacing:2rem;font-size:var(--text-lg);box-shadow:var(--shadow-pop-lg)}
.bt-card[data-size=xl] .bt-card-title{font-size:var(--text-2xl)}
.bt-card[data-size=lg] .bt-card-title{font-size:var(--text-lg)}
.bt-card>img:first-child{border-top-left-radius:var(--radius-xl);border-top-right-radius:var(--radius-xl)}
.bt-card>img:last-child{border-bottom-left-radius:var(--radius-xl);border-bottom-right-radius:var(--radius-xl)}
.bt-card-header{display:grid;grid-auto-rows:min-content;align-items:start;gap:.25rem;padding-inline:var(--bt-card-spacing)}
.bt-card-header:has([data-slot=card-action]){grid-template-columns:1fr auto}
.bt-card-title{font-size:var(--text-base);line-height:var(--leading-snug);font-weight:500}
.bt-card[data-size=sm] .bt-card-title{font-size:var(--text-sm)}
.bt-card-description{font-size:var(--text-sm);color:var(--muted-foreground)}
.bt-card-action{grid-column-start:2;grid-row:1/span 2;align-self:start;justify-self:end}
.bt-card-content{padding-inline:var(--bt-card-spacing)}
.bt-card-footer{display:flex;align-items:center;padding:var(--bt-card-spacing);border-top:2px solid var(--border);background:color-mix(in oklab,var(--muted) 50%,transparent);border-bottom-left-radius:var(--radius-xl);border-bottom-right-radius:var(--radius-xl)}
.bt-card:has(.bt-card-footer){padding-bottom:0}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "card");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Card({ size = "default", className = "", children, ...rest }) {
  inject();
  return (
    <div data-slot="card" data-size={size} className={["bt-card", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-header" className={["bt-card-header", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-title" className={["bt-card-title", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardDescription({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-description" className={["bt-card-description", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardAction({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-action" className={["bt-card-action", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardContent({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-content" className={["bt-card-content", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className = "", children, ...rest }) {
  return (
    <div data-slot="card-footer" className={["bt-card-footer", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
