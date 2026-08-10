import React from "react";
import { Label } from "./Label.jsx";

const CSS = `
.bt-field-group{display:flex;width:100%;flex-direction:column;gap:1.25rem}
.bt-field{display:flex;width:100%;gap:.5rem}
.bt-field[data-orientation=vertical]{flex-direction:column}
.bt-field[data-orientation=vertical]>*{width:100%}
.bt-field[data-orientation=horizontal]{flex-direction:row;align-items:center}
.bt-field[data-invalid=true]{color:var(--destructive)}
.bt-field[data-warning=true]:not([data-invalid=true]){color:var(--warning)}
.bt-field-content{display:flex;flex:1;flex-direction:column;gap:.125rem;line-height:var(--leading-snug)}
.bt-field-description{margin:.5rem 0 0;text-align:left;font-size:var(--text-sm);line-height:var(--leading-normal);font-weight:400;color:var(--muted-foreground)}
.bt-field-error{font-size:var(--text-sm);font-weight:600;color:var(--destructive)}
.bt-field-warning{display:flex;align-items:center;gap:.25rem;font-size:var(--text-sm);font-weight:600;color:var(--warning)}
.bt-field-set{display:flex;flex-direction:column;gap:1rem;border:0;padding:0;margin:0}
.bt-field-legend{margin-bottom:.375rem;font-weight:600;font-size:var(--text-sm);color:var(--foreground)}
`;

let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const s = document.createElement("style");
  s.setAttribute("data-buttery", "field");
  s.textContent = CSS;
  document.head.appendChild(s);
}
inject();

export function FieldGroup({ className = "", children, ...rest }) {
  inject();
  return (
    <div data-slot="field-group" className={["bt-field-group", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function Field({ orientation = "vertical", className = "", children, ...rest }) {
  inject();
  return (
    <div role="group" data-slot="field" data-orientation={orientation} className={["bt-field", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function FieldLabel({ className = "", children, ...rest }) {
  return (
    <Label data-slot="field-label" className={className} {...rest}>
      {children}
    </Label>
  );
}

export function FieldContent({ className = "", children, ...rest }) {
  return (
    <div data-slot="field-content" className={["bt-field-content", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function FieldDescription({ className = "", children, ...rest }) {
  return (
    <p data-slot="field-description" className={["bt-field-description", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </p>
  );
}

export function FieldError({ className = "", children, ...rest }) {
  if (!children) return null;
  return (
    <div role="alert" data-slot="field-error" className={["bt-field-error", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

/* The advisory sibling of FieldError: amber, prefixed with a ⚠︎, and saying something
 * the user is free to ignore. Deliberately NOT role="alert" — an error interrupts
 * because the form is about to refuse; a warning is a note in the margin, and hijacking
 * the live region for one trains people to tune the region out. Pair it with
 * `data-warning="true"` on the control itself. */
export function FieldWarning({ className = "", children, ...rest }) {
  if (!children) return null;
  return (
    <div data-slot="field-warning" className={["bt-field-warning", className].filter(Boolean).join(" ")} {...rest}>
      <span aria-hidden="true">⚠︎</span>
      {children}
    </div>
  );
}

export function FieldSet({ className = "", children, ...rest }) {
  inject();
  return (
    <fieldset data-slot="field-set" className={["bt-field-set", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </fieldset>
  );
}

export function FieldLegend({ className = "", children, ...rest }) {
  return (
    <legend data-slot="field-legend" className={["bt-field-legend", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </legend>
  );
}
