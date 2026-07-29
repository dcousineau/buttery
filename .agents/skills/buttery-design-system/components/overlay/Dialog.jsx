import React from "react";
import { Button } from "../core/Button.jsx";

const CSS = `
.bt-dialog-backdrop{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.2);transition:opacity .15s ease}
@supports (backdrop-filter:blur(2px)){.bt-dialog-backdrop{backdrop-filter:blur(2px)}}
.bt-dialog{position:fixed;top:50%;left:50%;z-index:50;display:flex;width:calc(100vw - 2rem);max-width:28rem;transform:translate(-50%,-50%);flex-direction:column;gap:.75rem;border:2px solid var(--border);border-radius:var(--radius-xl);background:var(--card);color:var(--card-foreground);padding:1.25rem;box-shadow:var(--shadow-pop-md);transition:all .15s ease}
.bt-dialog-title{font-family:var(--font-display);font-weight:400;letter-spacing:var(--tracking-display);font-size:var(--text-lg);color:var(--foreground);margin:0}
.bt-dialog-desc{margin:0;font-size:var(--text-sm);color:var(--muted-foreground)}
.bt-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem;margin-top:.5rem}
.bt-dialog--sm{max-width:22rem}
.bt-dialog--lg{max-width:40rem;padding:1.5rem;gap:1rem}
.bt-dialog--lg .bt-dialog-title{font-size:var(--text-xl)}
.bt-dialog--xl{max-width:56rem;padding:2rem;gap:1.25rem}
.bt-dialog--xl .bt-dialog-title{font-size:var(--text-2xl)}
.bt-dialog--xl .bt-dialog-desc{font-size:var(--text-lg)}
/* Cook mode: the recipe owns the screen. Square corners, no scrim gap. */
.bt-dialog--fullscreen{top:0;left:0;transform:none;width:100vw;max-width:none;height:100vh;border:0;border-radius:0;padding:2rem;gap:1.5rem;box-shadow:none;background:var(--background);overflow:auto}
.bt-dialog--fullscreen .bt-dialog-title{font-size:3rem;line-height:1.08}
.bt-dialog--fullscreen .bt-dialog-desc{font-size:var(--text-xl)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "dialog");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Dialog({ open = false, onOpenChange, size = "default", className = "", children, ...rest }) {
  inject();
  if (!open) return null;
  const fullscreen = size === "fullscreen";
  return (
    <>
      {fullscreen ? null : <div className="bt-dialog-backdrop" onClick={() => onOpenChange?.(false)} />}
      <div role="dialog" aria-modal="true" className={["bt-dialog", `bt-dialog--${size}`, className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </div>
    </>
  );
}

export function DialogTitle({ className = "", children, ...rest }) {
  return (
    <h2 className={["bt-dialog-title", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </h2>
  );
}

export function DialogDescription({ className = "", children, ...rest }) {
  return (
    <p className={["bt-dialog-desc", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </p>
  );
}

export function DialogActions({ className = "", children, ...rest }) {
  return (
    <div className={["bt-dialog-actions", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, pending = false, onConfirm }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{description}</DialogDescription>
      <DialogActions>
        <Button variant="ghost" disabled={pending} onClick={() => onOpenChange?.(false)}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
