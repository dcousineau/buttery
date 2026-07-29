import React from "react";

const CSS = `
.bt-menu-root{position:relative;display:inline-flex}
.bt-menu{position:absolute;z-index:50;min-width:12rem;max-height:24rem;overflow-y:auto;border:2px solid var(--border);border-radius:var(--radius-lg);background:var(--popover);color:var(--popover-foreground);padding:4px;box-shadow:var(--shadow-pop-md)}
.bt-menu[data-align=end]{right:0}
.bt-menu[data-align=start]{left:0}
.bt-menu[data-side=bottom]{top:calc(100% + 4px)}
.bt-menu[data-side=top]{bottom:calc(100% + 4px)}
.bt-menu-label{padding:4px 6px;font-size:var(--text-xs);font-weight:500;color:var(--muted-foreground)}
.bt-menu-item{position:relative;display:flex;align-items:center;gap:.375rem;border-radius:var(--radius-sm);padding:4px 6px;font-size:var(--text-sm);color:inherit;text-decoration:none;user-select:none;background:none;border:0;width:100%;text-align:left;font-family:var(--font-sans);cursor:var(--cursor-interactive)}
.bt-menu-item>svg{width:1rem;height:1rem;flex-shrink:0;pointer-events:none}
.bt-menu-item:hover,.bt-menu-item:focus-visible{background:var(--accent);color:var(--accent-foreground);outline:none}
.bt-menu-item[data-variant=destructive]{color:var(--destructive)}
.bt-menu-item[data-variant=destructive]:hover{background:color-mix(in oklab,var(--destructive) 10%,transparent);color:var(--destructive)}
.bt-menu-item[aria-disabled=true]{pointer-events:none;opacity:.5}
.bt-menu-separator{height:1px;margin:4px -4px;background:var(--border)}
.bt-menu-shortcut{margin-left:auto;font-size:var(--text-xs);letter-spacing:.1em;color:var(--muted-foreground)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "dropdown-menu");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

const Ctx = React.createContext({ open: false, setOpen: () => {} });

export function DropdownMenu({ children, defaultOpen = false }) {
  inject();
  const [open, setOpen] = React.useState(defaultOpen);
  const ref = React.useRef(null);
  React.useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);
  return (
    <Ctx.Provider value={{ open, setOpen }}>
      <span className="bt-menu-root" ref={ref} data-slot="dropdown-menu">
        {children}
      </span>
    </Ctx.Provider>
  );
}

export function DropdownMenuTrigger({ children }) {
  const { open, setOpen } = React.useContext(Ctx);
  const child = React.Children.only(children);
  return React.cloneElement(child, {
    "aria-expanded": open,
    onClick: (e) => {
      child.props.onClick?.(e);
      setOpen(!open);
    },
  });
}

export function DropdownMenuContent({ align = "start", side = "bottom", className = "", children, ...rest }) {
  const { open } = React.useContext(Ctx);
  if (!open) return null;
  return (
    <div role="menu" data-slot="dropdown-menu-content" data-align={align} data-side={side} className={["bt-menu", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function DropdownMenuGroup({ children, ...rest }) {
  return (
    <div role="group" {...rest}>
      {children}
    </div>
  );
}

export function DropdownMenuLabel({ className = "", children, ...rest }) {
  return (
    <div className={["bt-menu-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function DropdownMenuItem({ variant = "default", as, className = "", children, ...rest }) {
  const { setOpen } = React.useContext(Ctx);
  const Tag = as || (rest.href ? "a" : "button");
  return (
    <Tag
      role="menuitem"
      type={Tag === "button" ? "button" : undefined}
      data-variant={variant}
      className={["bt-menu-item", className].filter(Boolean).join(" ")}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        setOpen(false);
      }}
    >
      {children}
    </Tag>
  );
}

export function DropdownMenuSeparator({ className = "", ...rest }) {
  return <div role="separator" className={["bt-menu-separator", className].filter(Boolean).join(" ")} {...rest} />;
}

export function DropdownMenuShortcut({ className = "", children, ...rest }) {
  return (
    <span className={["bt-menu-shortcut", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </span>
  );
}
