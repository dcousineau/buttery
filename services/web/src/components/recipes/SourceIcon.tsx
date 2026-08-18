import { BookOpenText, ExternalLink, Pencil } from "lucide-react";
import type { SourceKind } from "#/lib/api";

/**
 * The provenance glyph keyed to a recipe's source kind (design handoff):
 *   web = external-link · handwritten/offline note = pencil · atproto handle =
 *   book-open-text. Not a link — a provenance label.
 */
export function SourceIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = kind === "web" ? ExternalLink : kind === "note" ? Pencil : BookOpenText;
  return <Icon className={className} aria-hidden="true" />;
}
