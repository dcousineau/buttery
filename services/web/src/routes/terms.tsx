import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../components/LegalPage";
import { seo } from "../lib/seo";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: seo({
      title: "Terms of Service · Buttery",
      description: "An informal terms of service for Buttery during its development period.",
    }),
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage eyebrow="Legal" title="Terms of Service" updated="July 26, 2026" ail={4}>
      <p>
        Buttery is an open source, experimental project and is provided <strong>&ldquo;as is,&rdquo;</strong> without warranties of any kind. It is a publicly available private
        test, not a finished commercial product. If you require legal assurances, guaranteed uptime, or regulatory compliance, we do <strong>not</strong> recommend relying on
        Buttery at this time.
      </p>

      <h2>What Buttery does</h2>
      <p>
        Buttery lets you store, organize, view, and share cooking recipes. You sign in with your existing <strong>AT Protocol (atproto) account</strong>, and Buttery reads and
        publishes recipes to your atproto account on your behalf. Recipes are therefore stored the way atproto works: the authoritative copy lives in your own personal data server
        (PDS), while Buttery&rsquo;s servers keep a copy of that data to run the app. Because your recipes live in your own atproto repository, you own them and may take them with
        you or access them independently of Buttery at any time.
      </p>
      <p>
        Some features are <strong>not</strong> part of atproto and instead store private data in <strong>Buttery&rsquo;s own database</strong> — including but not limited to
        shopping lists, meal planning, and private collections. This data is held on Buttery&rsquo;s servers and is not published to atproto. See our{" "}
        <a href="/privacy">Privacy Policy</a> for how we handle it.
      </p>

      <h2>Your account and content</h2>
      <ul>
        <li>You are responsible for your atproto account, your handle, and the content you create or share through Buttery.</li>
        <li>Buttery does not host atproto accounts. Account creation, recovery, and security are handled by your atproto provider, subject to their terms.</li>
        <li>Do not use Buttery for anything unlawful, or to store or share content you do not have the right to store or share.</li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The service is provided without warranty of any kind, express or implied. We make no promise that Buttery will be available, error-free, secure, or that any data will be
        preserved. To the fullest extent permitted by law, we are not liable for any loss or damage arising from your use of the service.
      </p>

      <h2>Hosting and applicable law</h2>
      <p>
        Our servers are hosted in the United States of America and are therefore subject to United States federal and local law. By using Buttery you acknowledge your data may be
        processed in the United States.
      </p>

      <h2>Changes</h2>
      <p>
        This is an early, informal version of these terms. As Buttery matures we will likely formalize its Terms of Service. We may update or replace these terms at any time, and
        continued use of the service constitutes acceptance of the current terms.
      </p>
    </LegalPage>
  );
}
