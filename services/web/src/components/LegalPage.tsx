import { ExternalLink } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import type { ReactNode } from "react";

/** Canonical AI Influence Level definition. Exported so no page hand-types it. */
export const AIL_URL = "https://danielmiessler.com/blog/ai-influence-level-ail";

const AIL_COPY: Record<number, string> = {
  1: "Human-written, with minimal AI assistance.",
  4: "Drafted by AI and reviewed by a human before publishing.",
};

/** Inline text link to somewhere off Buttery — always gets the external-link icon. */
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-4 [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {children}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

/**
 * Shared shell for the static legal-ish pages (terms, privacy, AI usage).
 * Content is authored as plain markup in the `children` and styled uniformly
 * here; each page declares the AI Influence Level shown in the footer.
 */
export function LegalPage({ eyebrow, title, updated, ail, children }: { eyebrow: string; title: string; updated?: string; ail: 1 | 4; children: ReactNode }) {
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <article className="rise-in mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            {eyebrow}
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">{title}</h1>
          {updated ? <p className="mt-3 mb-0 text-xs text-muted-foreground">Last updated {updated}</p> : null}
        </header>

        <div className="flex flex-col gap-4 text-sm text-muted-foreground sm:text-base [&_a]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-4 [&_h2]:mb-0 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-foreground [&_li]:pl-1 [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:m-0 [&_strong]:text-foreground [&_ul]:m-0 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
          {children}
        </div>

        <footer className="mt-2 border-t-2 border-border pt-4">
          <p className="m-0 text-xs text-muted-foreground">
            <strong className="text-foreground">AI Influence Level: AIL-{ail}</strong> — {AIL_COPY[ail]} <LegalLink href={AIL_URL}>What&rsquo;s an AI Influence Level?</LegalLink>
          </p>
        </footer>
      </article>
    </div>
  );
}
