import React from "react";

const CSS = `
.bt-acc{display:flex;flex-direction:column;gap:.5rem}
.bt-acc-item{border:2px solid var(--border);border-radius:var(--radius-lg);background:var(--card);color:var(--card-foreground);box-shadow:var(--shadow-pop-sm);overflow:hidden}
.bt-acc-item[data-open=true]{box-shadow:var(--shadow-pop-md)}
.bt-acc-trigger{display:flex;width:100%;align-items:center;gap:.75rem;border:0;background:none;font-family:var(--font-sans);font-weight:600;text-align:left;color:inherit;cursor:var(--cursor-interactive)}
.bt-acc-trigger:hover{background:var(--accent);color:var(--accent-foreground)}
.bt-acc-trigger:focus-visible{outline:3px solid var(--ring);outline-offset:-3px}
.bt-acc-chevron{margin-left:auto;flex-shrink:0;transition:transform .12s ease}
.bt-acc-item[data-open=true] .bt-acc-chevron{transform:rotate(90deg)}
.bt-acc-panel{border-top:2px solid var(--border)}
.bt-acc--default .bt-acc-trigger{min-height:var(--control-h-lg);padding:8px var(--control-px-lg);font-size:var(--text-base)}
.bt-acc--default .bt-acc-panel{padding:12px var(--control-px-lg);font-size:var(--text-sm)}
.bt-acc--sm .bt-acc-trigger{min-height:var(--control-h);padding:6px var(--control-px);font-size:var(--text-sm)}
.bt-acc--sm .bt-acc-panel{padding:10px var(--control-px);font-size:var(--text-sm)}
.bt-acc--xl .bt-acc-trigger{min-height:var(--control-h-xl);padding:14px var(--control-px-xl);font-size:var(--text-xl)}
.bt-acc--xl .bt-acc-panel{padding:18px var(--control-px-xl);font-size:var(--text-lg);line-height:var(--leading-relaxed)}
.bt-acc--xl .bt-acc-item{border-radius:var(--radius-xl);box-shadow:var(--shadow-pop-md)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "accordion");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

const Ctx = React.createContext({ open: [], toggle: () => {}, size: "default" });

/** `type="single"` collapses siblings; `multiple` lets several stay open (the
 * right default for a recipe broken into stages you keep referring back to). */
export function Accordion({ type = "multiple", defaultOpen = [], size = "default", className = "", children, ...rest }) {
  inject();
  const [open, setOpen] = React.useState(defaultOpen);
  const toggle = React.useCallback(
    (value) => setOpen((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : type === "single" ? [value] : [...prev, value])),
    [type],
  );
  return (
    <div data-slot="accordion" className={["bt-acc", `bt-acc--${size}`, className].filter(Boolean).join(" ")} {...rest}>
      <Ctx.Provider value={{ open, toggle, size }}>{children}</Ctx.Provider>
    </div>
  );
}

const ItemCtx = React.createContext({ value: null, isOpen: false });

export function AccordionItem({ value, className = "", children, ...rest }) {
  const { open } = React.useContext(Ctx);
  const isOpen = open.includes(value);
  return (
    <ItemCtx.Provider value={{ value, isOpen }}>
      <div data-slot="accordion-item" data-open={isOpen} className={["bt-acc-item", className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </div>
    </ItemCtx.Provider>
  );
}

export function AccordionTrigger({ className = "", children, ...rest }) {
  const { toggle } = React.useContext(Ctx);
  const { value, isOpen } = React.useContext(ItemCtx);
  return (
    <button
      type="button"
      data-slot="accordion-trigger"
      aria-expanded={isOpen}
      onClick={() => toggle(value)}
      className={["bt-acc-trigger", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
      <svg className="bt-acc-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

export function AccordionContent({ className = "", children, ...rest }) {
  const { isOpen } = React.useContext(ItemCtx);
  if (!isOpen) return null;
  return (
    <div data-slot="accordion-content" className={["bt-acc-panel", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
