import React from "react";

const CSS = `
.bt-sidebar{display:flex;flex-direction:column;width:var(--sidebar-width);background:var(--sidebar);color:var(--sidebar-foreground);border-right:2px solid var(--sidebar-border);flex-shrink:0}
.bt-sidebar-content{display:flex;min-height:0;flex:1;flex-direction:column;gap:0;overflow:auto}
.bt-sidebar-group{position:relative;display:flex;width:100%;min-width:0;flex-direction:column;padding:.5rem}
.bt-sidebar-group-label{display:flex;height:32px;flex-shrink:0;align-items:center;border-radius:var(--radius-sm);padding:0 .5rem;font-size:var(--text-xs);font-weight:500;color:color-mix(in oklab,var(--sidebar-foreground) 70%,transparent)}
.bt-sidebar-menu{display:flex;width:100%;min-width:0;flex-direction:column;gap:0;list-style:none;margin:0;padding:0}
.bt-sidebar-item{position:relative}
.bt-sidebar-btn{display:flex;width:100%;height:32px;align-items:center;gap:.5rem;overflow:hidden;border:2px solid transparent;border-radius:var(--radius-sm);padding:0 .5rem;text-align:left;font-family:var(--font-sans);font-size:var(--text-sm);color:inherit;text-decoration:none;background:none;cursor:var(--cursor-interactive)}
.bt-sidebar-btn>svg{width:1rem;height:1rem;flex-shrink:0}
.bt-sidebar-btn>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-sidebar-btn:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
.bt-sidebar-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--sidebar-ring)}
.bt-sidebar-btn[aria-disabled=true]{pointer-events:none;opacity:.5}
.bt-sidebar-btn[data-active=true]{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);font-weight:500;border-color:var(--border);box-shadow:var(--shadow-pop-sm)}
.bt-sidebar-badge{position:absolute;right:.25rem;top:.375rem;pointer-events:none;display:flex;height:20px;min-width:20px;align-items:center;justify-content:center;border-radius:var(--radius-sm);padding:0 .25rem;font-size:var(--text-xs);font-weight:500;color:var(--muted-foreground);user-select:none}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "sidebar");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Sidebar({ className = "", children, ...rest }) {
  inject();
  return (
    <nav data-slot="sidebar" className={["bt-sidebar", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </nav>
  );
}

export function SidebarContent({ className = "", children, ...rest }) {
  return (
    <div data-slot="sidebar-content" className={["bt-sidebar-content", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function SidebarGroup({ className = "", children, ...rest }) {
  return (
    <div data-slot="sidebar-group" className={["bt-sidebar-group", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function SidebarGroupLabel({ className = "", children, ...rest }) {
  return (
    <div data-slot="sidebar-group-label" className={["bt-sidebar-group-label", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function SidebarMenu({ className = "", children, ...rest }) {
  return (
    <ul data-slot="sidebar-menu" className={["bt-sidebar-menu", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </ul>
  );
}

export function SidebarMenuItem({ className = "", children, ...rest }) {
  return (
    <li data-slot="sidebar-menu-item" className={["bt-sidebar-item", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </li>
  );
}

export function SidebarMenuButton({ isActive = false, as, className = "", children, ...rest }) {
  const Tag = as || (rest.href ? "a" : "button");
  return (
    <Tag data-slot="sidebar-menu-button" data-active={isActive || undefined} className={["bt-sidebar-btn", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </Tag>
  );
}

export function SidebarMenuBadge({ className = "", children, ...rest }) {
  return (
    <div data-slot="sidebar-menu-badge" className={["bt-sidebar-badge", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}
