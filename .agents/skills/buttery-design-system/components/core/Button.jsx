import React from "react";

/* Neo-brutalist sticker physics: 2px ink border, hard offset shadow, lifts on
 * hover, presses down on click. Solid variants only — ghost/link stay flat. */
const CSS = `
.bt-btn{--bt-shadow:var(--shadow-pop);display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;gap:.375rem;white-space:nowrap;border:2px solid transparent;background-clip:padding-box;border-radius:var(--radius-lg);font-family:var(--font-sans);font-size:var(--text-sm);font-weight:600;line-height:1;text-decoration:none;transition:all .12s ease;outline:none;user-select:none;cursor:var(--cursor-interactive)}
.bt-btn>svg{flex-shrink:0;pointer-events:none;width:1rem;height:1rem}
.bt-btn:focus-visible{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 50%,transparent)}
.bt-btn[disabled],.bt-btn[aria-disabled=true]{pointer-events:none;opacity:.5}
.bt-btn--pop{box-shadow:var(--bt-shadow)}
.bt-btn--pop:hover{transform:translate(-2px,-2px);box-shadow:var(--shadow-pop-lg)}
.bt-btn--pop:active{transform:translate(2px,2px);box-shadow:var(--shadow-pop-sm)}
.bt-btn--pop[disabled]{transform:none;box-shadow:var(--shadow-pop)}
.bt-btn--default{border-color:var(--border);background:var(--primary);color:var(--primary-foreground)}
.bt-btn--secondary{border-color:var(--border);background:var(--secondary);color:var(--secondary-foreground)}
.bt-btn--outline{border-color:var(--border);background:var(--card);color:var(--foreground)}
.bt-btn--outline:hover{background:var(--accent)}
.bt-btn--destructive{border-color:var(--border);background:var(--destructive);color:var(--primary-foreground)}
.bt-btn--ghost{background:transparent;color:inherit}
.bt-btn--ghost:hover{background:var(--muted);color:var(--foreground)}
.bt-btn--link{background:transparent;color:var(--primary);text-underline-offset:4px}
.bt-btn--link:hover{text-decoration:underline}
.bt-btn--xs{height:var(--control-h-xs);gap:.25rem;padding:0 var(--control-px-xs);font-size:var(--text-xs);border-radius:min(var(--radius-md),10px)}
.bt-btn--xs>svg{width:.75rem;height:.75rem}
.bt-btn--sm{height:var(--control-h-sm);gap:.25rem;padding:0 var(--control-px-sm);font-size:.8rem;border-radius:min(var(--radius-md),12px)}
.bt-btn--sm>svg{width:.875rem;height:.875rem}
.bt-btn--default-size{height:var(--control-h);padding:0 var(--control-px)}
.bt-btn--lg{height:var(--control-h-lg);padding:0 var(--control-px-lg)}
.bt-btn--icon{height:var(--control-h);width:var(--control-h);padding:0}
.bt-btn--icon-xs{height:var(--control-h-xs);width:var(--control-h-xs);padding:0;border-radius:min(var(--radius-md),10px)}
.bt-btn--icon-xs>svg{width:.75rem;height:.75rem}
.bt-btn--icon-sm{height:var(--control-h-sm);width:var(--control-h-sm);padding:0;border-radius:min(var(--radius-md),12px)}
.bt-btn--icon-lg{height:var(--control-h-lg);width:var(--control-h-lg);padding:0}
/* xl / 2xl exist for cook mode: full-screen, arm's-length, flour-on-your-hands. */
.bt-btn--xl{height:var(--control-h-xl);gap:.5rem;padding:0 var(--control-px-xl);font-size:var(--text-lg);border-radius:var(--radius-xl)}
.bt-btn--xl>svg{width:1.25rem;height:1.25rem}
.bt-btn--2xl{height:var(--control-h-2xl);gap:.75rem;padding:0 var(--control-px-2xl);font-size:var(--text-2xl);border-radius:var(--radius-xl)}
.bt-btn--2xl>svg{width:1.75rem;height:1.75rem}
.bt-btn--icon-xl{height:var(--control-h-xl);width:var(--control-h-xl);padding:0;border-radius:var(--radius-xl)}
.bt-btn--icon-xl>svg{width:1.25rem;height:1.25rem}
.bt-btn--icon-2xl{height:var(--control-h-2xl);width:var(--control-h-2xl);padding:0;border-radius:var(--radius-xl)}
.bt-btn--icon-2xl>svg{width:1.75rem;height:1.75rem}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "button");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

const SIZE_CLASS = {
  xs: "bt-btn--xs",
  sm: "bt-btn--sm",
  default: "bt-btn--default-size",
  lg: "bt-btn--lg",
  icon: "bt-btn--icon",
  "icon-xs": "bt-btn--icon-xs",
  "icon-sm": "bt-btn--icon-sm",
  "icon-lg": "bt-btn--icon-lg",
  xl: "bt-btn--xl",
  "2xl": "bt-btn--2xl",
  "icon-xl": "bt-btn--icon-xl",
  "icon-2xl": "bt-btn--icon-2xl",
};

const FLAT = new Set(["ghost", "link"]);

export function Button({ variant = "default", size = "default", as, className = "", children, ...rest }) {
  inject();
  const Tag = as || (rest.href ? "a" : "button");
  const classes = ["bt-btn", `bt-btn--${variant}`, SIZE_CLASS[size] || SIZE_CLASS.default, FLAT.has(variant) ? "" : "bt-btn--pop", className].filter(Boolean).join(" ");
  return (
    <Tag className={classes} data-slot="button" {...rest}>
      {children}
    </Tag>
  );
}
