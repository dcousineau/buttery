import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, LegalLink } from "../components/LegalPage";
import { seo } from "../lib/seo";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: seo({
      title: "Privacy Policy · Buttery",
      description: "An informal privacy policy for Buttery during its development phase.",
    }),
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage eyebrow="Legal" title="Privacy Policy" updated="August 9, 2026" ail={4}>
      <p>
        Buttery is an open source, experimental project and is provided <strong>&ldquo;as is.&rdquo;</strong> We take your privacy seriously and protect your data to the best of
        our ability, but Buttery is a publicly available private test and does <strong>not</strong> yet offer formal privacy guarantees or regulatory compliance. If you require
        such assurances, we do not recommend using Buttery at this time.
      </p>

      <h2>Where your data lives</h2>
      <p>
        Your data lives in two places. <strong>Recipes</strong> are stored on <strong>your own AT Protocol (atproto) account</strong> and personal data server (PDS) — the
        authoritative copy is in your PDS, and Buttery&rsquo;s servers keep a copy to run the app. Your identity (your DID and handle) is controlled by your atproto provider,
        subject to their privacy practices. You own your recipe content and can take it with you or access it independently of Buttery at any time.
      </p>
      <p>
        Other features are <strong>not</strong> part of atproto and store private data in <strong>Buttery&rsquo;s own database</strong> on our servers — including but not limited
        to shopping lists, meal planning, and private collections. This data is not published to atproto and is intended to stay private to your account.
      </p>

      <h2>What we process</h2>
      <ul>
        <li>
          <strong>Authentication data</strong> — to sign you in, we use atproto OAuth. We store session information (including your DID and OAuth tokens) so you stay signed in and
          so Buttery can read and write recipe records on your behalf.
        </li>
        <li>
          <strong>Recipe data</strong> — read from and published to your atproto repository. Buttery&rsquo;s servers keep a copy of this data to run the app, but the authoritative
          copy lives in your PDS.
        </li>
        <li>
          <strong>Private app data</strong> — features not backed by atproto (such as shopping lists, meal planning, and private collections) are stored in Buttery&rsquo;s database
          on our servers and are not published to atproto.
        </li>
        <li>
          <strong>Basic operational data</strong> — like standard server logs needed to run and secure the service.
        </li>
        <li>
          <strong>Product analytics data</strong> — usage events, feature flag evaluations, and error reports sent to PostHog (see below).
        </li>
      </ul>

      <h2>What we do with it</h2>
      <p>
        We use this data only to operate Buttery — to authenticate you and to display, store, and share your recipes and app data as you direct. We do not sell your data. Recipes
        you choose to share are, by nature, visible to those you share them with and may be publicly accessible via atproto. Private app data stored in Buttery&rsquo;s database is
        not published to atproto.
      </p>

      <h2>Analytics and third-party processors</h2>
      <p>
        Buttery uses <LegalLink href="https://posthog.com/">PostHog</LegalLink> to understand how the app is used, to drive feature flagging and gradual rollouts, and to power
        various other in-app functionality (such as error reporting and the in-app support widget). This means data about how you use Buttery — page views, in-app events and
        interactions, error reports, and, once you sign in, your atproto DID, handle, and display name — is sent to PostHog and processed on our behalf as a third-party data
        processor. We do not send your recipe content, shopping lists, or meal plans to PostHog as analytics data.
      </p>
      <p>
        We currently use PostHog&rsquo;s <strong>US Cloud</strong>, so this analytics data is stored and processed in the United States. PostHog describes what it collects and how
        it handles data in its own <LegalLink href="https://posthog.com/privacy">privacy policy</LegalLink>, and documents its privacy and compliance practices in its{" "}
        <LegalLink href="https://posthog.com/docs/privacy">privacy documentation</LegalLink>.
      </p>

      <h2>Data requests</h2>
      <p>
        We will do our best to respond to standard data privacy requests (such as questions about, or deletion of, data we hold). Because your recipe content lives in your own
        atproto account, much of it is already under your direct control and can be managed or removed through your atproto provider. Private app data stored in Buttery&rsquo;s own
        database (such as shopping lists and meal plans) is held on our servers, and we will do our best to honor requests to access or delete it.
      </p>

      <h2>Hosting and applicable law</h2>
      <p>
        Our servers are hosted in the United States of America and are therefore subject to United States federal and local law. By using Buttery you acknowledge your data may be
        processed in the United States.
      </p>

      <h2>Changes</h2>
      <p>
        This is an early, informal version of this policy. As Buttery matures we will likely formalize its Privacy Policy. We may update or replace this policy at any time, and
        continued use of the service constitutes acceptance of the current policy.
      </p>
    </LegalPage>
  );
}
