import React from "react";

const CSS = `
.bt-spinner{width:1rem;height:1rem;flex-shrink:0;animation:bt-spin 1s linear infinite}
@keyframes bt-spin{to{transform:rotate(360deg)}}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "spinner");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

/* Lucide `loader-2` path data — the same icon the app spins (lucide-react Loader2Icon). */
export function Spinner({ className = "", ...rest }) {
  inject();
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={["bt-spinner", className].filter(Boolean).join(" ")}
      {...rest}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
