import { ChevronRight } from "lucide-react";
import { CopyButton } from "./CopyButton";

/**
 * Pretty-printed, collapsible, independently-scrolling JSON viewer.
 *
 * The `<pre>` gets its own `overflow-auto` box with a capped height, so a big
 * blob (an atproto record body, a table's raw rows) scrolls inside itself in
 * both directions and never forces the devtools panel as a whole to scroll
 * horizontally.
 *
 * Native `<details>`/`<summary>` for the disclosure (AGENTS.md: prefer native
 * over a JS-driven accordion) — keyboard operable and screen-reader legible
 * for free. The copy button sits in an absolutely-positioned sibling `<div>`
 * rather than inside `<summary>`, so it is never a nested interactive
 * control (see `CopyButton`'s doc comment).
 */
export function JsonBlock({ value, label, defaultOpen = false }: { value: unknown; label: string; defaultOpen?: boolean }) {
  return (
    <div className="relative rounded-md border-2 border-border bg-card">
      <details open={defaultOpen} className="group/json">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 pr-24 pl-2 text-xs font-semibold text-foreground select-none [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/json:rotate-90" aria-hidden="true" />
          {label}
        </summary>
        <pre className="m-0 max-h-80 overflow-auto border-t-2 border-border/60 px-2 py-1.5 font-mono text-[0.6875rem] leading-snug text-foreground">{stringify(value)}</pre>
      </details>
      <div className="absolute top-1 right-1.5">
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Circular reference or a BigInt buried in the tree — JSON.stringify
    // throws rather than producing partial output. `String(value)` would
    // resolve to the useless "[object Object]" for exactly the object case
    // this branch exists for, so say what happened instead.
    return "<could not serialize this value as JSON>";
  }
}
