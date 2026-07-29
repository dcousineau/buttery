import React from "react";

const CSS = `
.bt-skeleton{border-radius:var(--radius-md);background:var(--muted);animation:bt-pulse 2s cubic-bezier(.4,0,.6,1) infinite}
@keyframes bt-pulse{0%,100%{opacity:1}50%{opacity:.5}}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "skeleton");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Skeleton({ className = "", ...rest }) {
  inject();
  return <div data-slot="skeleton" className={["bt-skeleton", className].filter(Boolean).join(" ")} {...rest} />;
}
