import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "#/components/ui/button";

/**
 * Copies `value` to the clipboard — pretty-printed JSON for anything that
 * isn't already a string. A dev inspecting a raw record almost always wants
 * it in an editor next; this is the one control that gets them there.
 *
 * `event.preventDefault()` first: this button is meant to sit inside a
 * native `<summary>` row's box (see `JsonBlock` / `DebugSectionCard`, which
 * position it absolutely over the row rather than nesting it *inside* the
 * `<summary>` — nested interactive controls are a known a11y trap, confusing
 * screen readers about what one click activates). Even positioned outside,
 * a click can still bubble to an ancestor `<summary>` and toggle its
 * disclosure; `preventDefault` on the click is what stops that without
 * needing `stopPropagation` (which wouldn't cancel the browser's default
 * toggle behavior anyway — only `preventDefault` does).
 */
export function CopyButton({ value, label, size = "xs" }: { value: unknown; label: string; size?: "xs" | "sm" }) {
  const [copied, setCopied] = useState(false);

  async function onCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button type="button" size={size} variant="outline" onClick={onCopy} aria-label={copied ? `${label} copied to clipboard` : `Copy ${label}`}>
      {copied ? <Check data-icon="inline-start" aria-hidden="true" /> : <Copy data-icon="inline-start" aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
