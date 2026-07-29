import React from "react";

const CSS = `
.bt-sheet-overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.1);transition:opacity .15s ease}
.bt-sheet{position:fixed;z-index:50;display:flex;flex-direction:column;gap:1rem;background:var(--popover);color:var(--popover-foreground);font-size:var(--text-sm);transition:transform .2s ease-in-out,opacity .2s ease-in-out}
.bt-sheet[data-side=left]{inset-block:0;left:0;height:100%;width:75%;max-width:20rem;border-right:2px solid var(--border)}
.bt-sheet[data-side=right]{inset-block:0;right:0;height:100%;width:75%;max-width:20rem;border-left:2px solid var(--border)}
.bt-sheet[data-side=top]{inset-inline:0;top:0;height:auto;border-bottom:2px solid var(--border)}
.bt-sheet[data-side=bottom]{inset-inline:0;bottom:0;height:auto;border-top:2px solid var(--border)}
.bt-sheet-header{display:flex;flex-direction:column;gap:.125rem;padding:1rem}
.bt-sheet-footer{margin-top:auto;display:flex;flex-direction:column;gap:.5rem;padding:1rem}
.bt-sheet-title{font-size:var(--text-base);font-weight:500;color:var(--foreground)}
.bt-sheet-description{font-size:var(--text-sm);color:var(--muted-foreground)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "sheet");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Sheet({ open = false, onOpenChange, side = "right", className = "", children, ...rest }) {
  inject();
  if (!open) return null;
  return (
    <>
      <div className="bt-sheet-overlay" onClick={() => onOpenChange?.(false)} />
      <div role="dialog" aria-modal="true" data-slot="sheet-content" data-side={side} className={["bt-sheet", className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </div>
    </>
  );
}

export function SheetHeader({ className = "", children, ...rest }) {
  return (
    <div className={["bt-sheet-header", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function SheetFooter({ className = "", children, ...rest }) {
  return (
    <div className={["bt-sheet-footer", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function SheetTitle({ className = "", children, ...rest }) {
  return (
    <h2 className={["bt-sheet-title", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </h2>
  );
}

export function SheetDescription({ className = "", children, ...rest }) {
  return (
    <p className={["bt-sheet-description", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </p>
  );
}
