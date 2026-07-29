import React from "react";

const CSS = `
.bt-separator{flex-shrink:0;background:var(--border);border:0;margin:0}
.bt-separator[data-orientation=horizontal]{height:1px;width:100%}
.bt-separator[data-orientation=vertical]{width:1px;align-self:stretch}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "separator");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Separator({ orientation = "horizontal", className = "", ...rest }) {
  inject();
  return <div role="separator" data-slot="separator" data-orientation={orientation} className={["bt-separator", className].filter(Boolean).join(" ")} {...rest} />;
}
