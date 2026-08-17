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
 * credits third-party content and the open source Buttery builds on. AIL-4:
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
        <li>
          <strong>Food lexicon</strong> — the shopping list decides what an ingredient is and which aisle it belongs in using a lexicon generated from the{" "}
          <LegalLink href="https://world.openfoodfacts.org/">Open Food Facts</LegalLink> ingredients taxonomy, published under the{" "}
          <LegalLink href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL) 1.0</LegalLink>. Our lexicon is a <strong>derived database</strong> under
          that license — it reuses their food identifiers, English names and hierarchy, and adds our own aisle assignments on top — and is offered under the ODbL in turn. The
          generated file ships with its own notice recording the exact source revision. Open Food Facts is a collaborative project, and the shopping list would not work without the
          years of volunteer work behind that taxonomy.
        </li>
      </ul>

      <h2>The foundations</h2>
      <p>Buttery is built with:</p>
      <ul>
        <li>
          <strong>
            <LegalLink href="https://atproto.com/">atproto</LegalLink>
          </strong>{" "}
          — the AT Protocol, and Bluesky&rsquo;s reference implementation of it. MIT, © 2022–2026 Bluesky Social PBC and Contributors.
        </li>
        <li>
          <strong>
            <LegalLink href="https://nodejs.org">Node.js</LegalLink>
          </strong>{" "}
          — MIT, © Node.js contributors and the OpenJS Foundation.
        </li>
        <li>
          <strong>
            <LegalLink href="https://www.postgresql.org">PostgreSQL</LegalLink>
          </strong>{" "}
          — PostgreSQL License, © 1996–2026 The PostgreSQL Global Development Group.
        </li>
        <li>
          <strong>
            <LegalLink href="https://redis.io">Redis</LegalLink>
          </strong>{" "}
          — source-available (RSALv2 / SSPLv1, plus AGPLv3 from Redis 8 onward), © Redis Ltd. Buttery runs it as a service rather than redistributing it.
        </li>
        <li>
          <strong>
            <LegalLink href="https://react.dev">React</LegalLink>
          </strong>{" "}
          — MIT, © Meta Platforms, Inc. and affiliates.
        </li>
        <li>
          <strong>
            <LegalLink href="https://tanstack.com/">TanStack</LegalLink>
          </strong>{" "}
          — Router and Start. MIT, © 2021–present Tanner Linsley and the TanStack contributors.
        </li>
      </ul>

      <p>
        If your work is credited here incorrectly — or belongs here and isn&rsquo;t — <LegalLink href="https://github.com/dcousineau/buttery/issues">open an issue</LegalLink> and
        we&rsquo;ll fix it.
      </p>
    </LegalPage>
  );
}
