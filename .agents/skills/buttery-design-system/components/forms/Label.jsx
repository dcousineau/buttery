import React from "react";

const CSS = `
.bt-label{display:flex;align-items:center;gap:.5rem;font-family:var(--font-sans);font-size:var(--text-sm);line-height:1;font-weight:500;user-select:none;color:inherit}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "label");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Label({ className = "", children, ...rest }) {
  inject();
  return (
    <label data-slot="label" className={["bt-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </label>
  );
}
