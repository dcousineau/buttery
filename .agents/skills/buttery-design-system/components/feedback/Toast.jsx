import React from "react";

const CSS = `
.bt-toast-viewport{position:fixed;z-index:60;display:flex;flex-direction:column;gap:.5rem;pointer-events:none;padding:1rem;width:min(24rem,100vw)}
.bt-toast-viewport[data-position=bottom-right]{right:0;bottom:0}
.bt-toast-viewport[data-position=bottom-center]{left:50%;bottom:0;transform:translateX(-50%)}
.bt-toast-viewport[data-position=top-right]{right:0;top:0}
.bt-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:.625rem;border:2px solid var(--border);border-radius:var(--radius-lg);background:var(--card);color:var(--card-foreground);padding:12px 14px;box-shadow:var(--shadow-pop-md);font-family:var(--font-sans);font-size:var(--text-sm);animation:bt-toast-in var(--duration-base) var(--ease-out-expo) both}
@keyframes bt-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.bt-toast>svg{flex-shrink:0;width:1rem;height:1rem;margin-top:1px}
.bt-toast--success{background:var(--secondary);color:var(--secondary-foreground)}
.bt-toast--destructive{background:var(--destructive);color:var(--primary-foreground)}
.bt-toast-body{min-width:0;flex:1}
.bt-toast-title{font-weight:600;line-height:var(--leading-snug)}
.bt-toast-desc{margin:.125rem 0 0;font-size:var(--text-sm);opacity:.85}
.bt-toast--default .bt-toast-desc{color:var(--muted-foreground);opacity:1}
.bt-toast-close{flex-shrink:0;display:grid;place-content:center;width:20px;height:20px;border:0;border-radius:var(--radius-sm);background:none;color:inherit;opacity:.6;cursor:var(--cursor-interactive)}
.bt-toast-close:hover{opacity:1}
.bt-toast--xl{padding:18px 20px;font-size:var(--text-xl);border-radius:var(--radius-xl);box-shadow:var(--shadow-pop-lg)}
.bt-toast--xl>svg{width:1.5rem;height:1.5rem}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "toast");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function ToastViewport({ position = "bottom-right", className = "", children, ...rest }) {
  inject();
  return (
    <div data-slot="toast-viewport" data-position={position} aria-live="polite" className={["bt-toast-viewport", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function Toast({ variant = "default", size = "default", title, description, onClose, className = "", children, ...rest }) {
  inject();
  return (
    <div role="status" data-slot="toast" className={["bt-toast", `bt-toast--${variant}`, size === "xl" ? "bt-toast--xl" : "", className].filter(Boolean).join(" ")} {...rest}>
      {children}
      <div className="bt-toast-body">
        {title ? <div className="bt-toast-title">{title}</div> : null}
        {description ? <p className="bt-toast-desc">{description}</p> : null}
      </div>
      {onClose ? (
        <button type="button" className="bt-toast-close" aria-label="Dismiss" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/** Minimal queue helper: `const { toasts, push, dismiss } = useToasts()`. */
export function useToasts(timeout = 4000) {
  const [toasts, setToasts] = React.useState([]);
  const dismiss = React.useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = React.useCallback(
    (toast) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { ...toast, id }]);
      if (timeout) setTimeout(() => dismiss(id), timeout);
      return id;
    },
    [dismiss, timeout],
  );
  return { toasts, push, dismiss };
}
