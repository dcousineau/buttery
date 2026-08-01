import { createFileRoute } from "@tanstack/react-router";
import { LegalLink, LegalPage } from "../components/LegalPage";
import { seo } from "../lib/seo";

export const Route = createFileRoute("/acknowledgements")({
  head: () => ({
    meta: seo({
      title: "Acknowledgements · Buttery",
      description: "Third-party content and open-source that Buttery is built on.",
    }),
  }),
  component: AcknowledgementsPage,
});

/**
 * The acknowledgements surface (plan §11b) — an ungated, content-only page that
 * credits third-party content and the open source Buttery builds on. Seeded here
 * with the CC0 alarm sound; structured so future entries append cleanly. AIL-4:
 * LLM-drafted, human-reviewed.
 */
function AcknowledgementsPage() {
  return (
    <LegalPage eyebrow="Acknowledgements" title="Acknowledgements" ail={4}>
      <p>
        Buttery is built on the work of others. This page is where we credit the third-party content we ship and the open-source software the app is built on. It will grow as the
        project does.
      </p>

      <h2>Assets</h2>
      <ul>
        <li>
          <strong>Timer alarm sound</strong> — &ldquo;Electronic alarm (buzzer) #2&rdquo; from{" "}
          <LegalLink href="https://bigsoundbank.com/detail-0089-electronic-alarm-buzzer-2.html">BigSoundBank</LegalLink>, released under{" "}
          <LegalLink href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0 (public domain)</LegalLink>. CC0 requires <strong>no</strong> attribution; we credit the
          source here voluntarily, with thanks.
        </li>
      </ul>

      <h2>Open source</h2>
      <p>Buttery stands on a large amount of open-source software. We&rsquo;ll credit those projects here as this page is filled out.</p>
    </LegalPage>
  );
}
