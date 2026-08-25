import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { LegalLink, LegalPage } from "../components/LegalPage";
import { seo } from "../lib/seo";

/** Where the Buy Me a Coffee page lives — the only place the URL appears. */
const BUY_ME_A_COFFEE_URL = "https://buymeacoffee.com/dcousineau";

/**
 * Buy Me a Coffee's own button-api image, painted in Buttery's palette: butter
 * `#ffd84d` fill, ink `#2a1e12` text, cream `#fff6e3` in the cup. Butter is byte-identical
 * in light and toasted, so one static image is correct in both themes — which
 * is the whole reason the brand constant is worth spending here.
 *
 * Their supported fonts are poppins, inter, bree, lato and arial. Two of their
 * params are narrower than they sound: `coffee_colour` paints only the liquid in
 * the cup, and `outline_colour` paints one band on the cup's lid — *not* a border
 * around the button, which their API cannot draw at all. The cup's remaining
 * twelve paths are hardcoded `#0d0c22` and are not themeable.
 *
 * They serve it as an SVG whose intrinsic size is 235x50 for this text; the
 * `width` and `height` below match, so the card does not reflow once it loads.
 * Change the `text` param and that size changes with it.
 */
const BUY_ME_A_COFFEE_BUTTON_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Support%20Buttery&slug=dcousineau&button_colour=FFD84D&font_colour=2A1E12&font_family=Inter&outline_colour=2A1E12&coffee_colour=FFF6E3";

export const Route = createFileRoute("/tip-jar")({
  head: () => ({
    meta: seo({
      title: "Tip Jar · Buttery",
      description: "Buttery is free to use. If you think it's worth something, the tip jar is here — one time or monthly, whatever you feel is fair.",
    }),
  }),
  component: TipJarPage,
});

/**
 * The tip-jar surface — an ungated, content-only page that asks for optional,
 * pay-what-you-like support without gating a single feature behind it.
 * Deliberately *not* called "Support" so it is never mistaken for tech support
 * (that lives in the account menu's support dialog). AIL-4: LLM-drafted,
 * human-reviewed.
 */
function TipJarPage() {
  return (
    <LegalPage eyebrow="Pay what you like" title="Tip Jar" ail={4}>
      <p>
        Buttery is free to use, and every feature is there for everyone, whether you put something in this jar or not. Tipping doesn&rsquo;t unlock anything, and not tipping
        doesn&rsquo;t cost you anything.
      </p>
      <p>
        I build Buttery in my spare time because my partner and I wanted a recipe box we would actually use. If it has earned a spot in your kitchen and you would like to chip in,
        I would be glad to have it.
      </p>

      <h2>What&rsquo;s a fair tip?</h2>
      <p>
        Whatever you think Buttery is worth. One time or every month, a couple of dollars or the price of a cookbook — you pick the number, and I am happy with it. If that number
        is zero, that is genuinely fine: use the app, cook something good.
      </p>

      <h2>Where it goes</h2>
      <p>
        Into keeping Buttery running — hosting, the database, image storage, the domain — and past that, into the time it takes to build the next thing. There is no company here,
        no investors, and no runway to extend. Just me and a hosting bill.
      </p>

      <TipJarSlot />

      <h2>Other ways to help</h2>
      <p>All of these are worth as much to me as money, and none of them cost anything:</p>
      <ul>
        <li>Tell someone who cooks about Buttery.</li>
        <li>
          File a bug or an idea on <LegalLink href="https://github.com/dcousineau/buttery">the repository</LegalLink>.
        </li>
        <li>
          Say hi on Bluesky at <LegalLink href="https://bsky.app/profile/dcousineau.com">@dcousineau.com</LegalLink>.
        </li>
      </ul>

      <p>Thanks for reading this far — and thanks for cooking with Buttery.</p>
    </LegalPage>
  );
}

/**
 * The button slot — Buy Me a Coffee's own hosted button image rather than one of
 * our `Button`s, so the tip jar looks like the thing it links to. `rel` is
 * `noopener` only: the referrer is deliberately left intact so Buy Me a Coffee
 * can attribute the visit to Buttery.
 */
function TipJarSlot() {
  return (
    <Card size="lg" className="my-2">
      <CardHeader>
        <CardTitle>Buy me a coffee</CardTitle>
        <CardDescription>Tips are handled by Buy Me a Coffee, on my personal page — one time or monthly, in whatever amount you choose.</CardDescription>
      </CardHeader>
      <CardContent>
        <a href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noopener" className="inline-block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <img src={BUY_ME_A_COFFEE_BUTTON_IMG} alt="Support Buttery on Buy Me a Coffee" width={235} height={50} className="h-auto w-[235px] max-w-full" />
        </a>
      </CardContent>
    </Card>
  );
}
