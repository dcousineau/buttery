import React from "react";

/* Input, Select and Textarea all read the SHARED control-height scale, so they
 * line up with Button and Badge at the same `size`.
 *
 * Three problem states, not two. `aria-invalid` is the blocking one: red, announced
 * as invalid, "this will not save". `data-warning="true"` is the advisory one: amber,
 * announced as nothing at all, "worth a look, and fine to ignore" — an ingredient
 * amount we couldn't read, a step mentioning a time we couldn't parse. Painting those
 * red teaches people to ignore red, which is the one thing red can't afford. A control
 * carries at most one; if a call site sets both, invalid wins by construction (the
 * `:not([aria-invalid=true])` guard) rather than by rule order. Warning sets no ARIA —
 * `aria-invalid` on something that saves fine lies to a screen reader — so pair it with
 * a `FieldWarning` for the words. */
const CSS = `
.bt-input,.bt-select{width:100%;min-width:0;border:2px solid var(--input);border-radius:var(--radius-lg);background:var(--card);color:var(--foreground);font-family:var(--font-sans);transition:box-shadow .12s ease,border-color .12s ease;outline:none}
.bt-input::placeholder{color:var(--muted-foreground)}
.bt-input:focus-visible,.bt-select:focus-visible,.bt-textarea:focus-visible{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 50%,transparent),var(--shadow-pop)}
.bt-input[disabled],.bt-select[disabled],.bt-textarea[disabled]{pointer-events:none;cursor:not-allowed;opacity:.5}
.bt-input[aria-invalid=true],.bt-select[aria-invalid=true],.bt-textarea[aria-invalid=true]{border-color:var(--destructive);box-shadow:0 0 0 3px color-mix(in oklab,var(--destructive) 20%,transparent)}
.bt-input[data-warning=true]:not([aria-invalid=true]),.bt-select[data-warning=true]:not([aria-invalid=true]),.bt-textarea[data-warning=true]:not([aria-invalid=true]){border-color:var(--warning);box-shadow:0 0 0 3px color-mix(in oklab,var(--warning) 25%,transparent)}
.bt-ctl--xs{height:var(--control-h-xs);padding:0 var(--control-px-xs);font-size:var(--text-xs)}
.bt-ctl--sm{height:var(--control-h-sm);padding:0 var(--control-px-sm);font-size:var(--text-sm)}
.bt-ctl--default{height:var(--control-h);padding:0 var(--control-px);font-size:var(--text-sm)}
.bt-ctl--lg{height:var(--control-h-lg);padding:0 var(--control-px-lg);font-size:var(--text-base)}
.bt-ctl--xl{height:var(--control-h-xl);padding:0 var(--control-px-xl);font-size:var(--text-lg);border-radius:var(--radius-xl)}
.bt-ctl--2xl{height:var(--control-h-2xl);padding:0 var(--control-px-2xl);font-size:var(--text-2xl);border-radius:var(--radius-xl)}
/* Native chevron replaced with the Lucide chevron-down path, ink-colored. */
.bt-select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%232a1e12' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 10px center;background-size:15px;padding-right:32px}
.dark .bt-select{background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fff4da' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>")}
.bt-textarea{width:100%;min-width:0;border:2px solid var(--input);border-radius:var(--radius-lg);background:var(--card);color:var(--foreground);font-family:var(--font-sans);font-size:var(--text-sm);line-height:var(--leading-normal);padding:8px var(--control-px);transition:box-shadow .12s ease,border-color .12s ease;outline:none;resize:vertical}
.bt-textarea::placeholder{color:var(--muted-foreground)}
.bt-textarea--lg{font-size:var(--text-base);padding:10px var(--control-px-lg)}
.bt-textarea--xl{font-size:var(--text-lg);padding:14px var(--control-px-xl);border-radius:var(--radius-xl)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "input");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function Input({ size = "default", className = "", type = "text", ...rest }) {
  inject();
  return <input type={type} data-slot="input" className={["bt-input", `bt-ctl--${size}`, className].filter(Boolean).join(" ")} {...rest} />;
}

export function Select({ size = "default", className = "", children, ...rest }) {
  inject();
  return (
    <select data-slot="select" className={["bt-select", `bt-ctl--${size}`, className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </select>
  );
}

/** Alias kept for the raw styled `<select>` the invite form uses. */
export function NativeSelect(props) {
  return <Select {...props} />;
}

export function Textarea({ size = "default", rows = 4, className = "", ...rest }) {
  inject();
  const sizeClass = size === "xl" || size === "2xl" ? "bt-textarea--xl" : size === "lg" ? "bt-textarea--lg" : "";
  return <textarea rows={rows} data-slot="textarea" className={["bt-textarea", sizeClass, className].filter(Boolean).join(" ")} {...rest} />;
}
