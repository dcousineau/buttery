/**
 * The per-recipe Open Graph image: a 1200×630 PNG rendered on the server from a
 * recipe's read model.
 *
 * Two pieces, on top of the model in `lib/og/recipe-card-model.ts` (which lives
 * over there because the recipe page needs it to build the image URL, and
 * anything this file imports — satori, resvg, ~400 KB of fonts — must never
 * follow it into the browser):
 *   1. `recipeOgFingerprint` — a digest of the model plus the layout version,
 *      used as the HTTP ETag and the Redis cache key. Two recipes that look
 *      identical produce identical bytes; bumping `OG_LAYOUT_VERSION`
 *      invalidates every cached image at once.
 *   2. `renderRecipeOgPng` — Satori lays the tree out and emits SVG, resvg
 *      rasterises it. Both are pulled in with dynamic `import()` inside the
 *      function, matching the `src/server/*` convention, so the native resvg
 *      binding never gets anywhere near the client graph.
 *
 * The model's own exports are re-exported here so a caller that renders has one
 * import, not two.
 *
 * This module is the ONE place in the app where raw brand hex is correct: Satori
 * has no stylesheet, no CSS variables and no Tailwind, so the tokens from
 * docs/BRAND.md are restated as literals in `BRAND` below.
 */
import { createHash } from "node:crypto";
import { OG_LAYOUT_VERSION, clamp, recipeOgModel, recipeOgVersion } from "#/lib/og/recipe-card-model";
import { ogFonts } from "./fonts";
import type { RecipeOgModel } from "#/lib/og/recipe-card-model";

export { recipeOgModel, recipeOgVersion };
export type { RecipeOgModel };

/** docs/BRAND.md palette, light mode. Neo-brutalism: flat fills, ink outlines,
 * hard un-blurred offset shadows. Muted ink is the de-emphasis tone. */
const BRAND = {
  cream: "#FFF6E3",
  paper: "#FFFDF4",
  ink: "#2A1E12",
  butter: "#FFD84D",
  red: "#E2231A",
  mutedInk: "#6B5B46",
} as const;

/**
 * Stable short digest of the model + layout version. Used as the ETag and as the
 * Redis cache key, so it has to change whenever the *pixels* would: that means
 * the whole model (not just the id) and the layout version go into the hash.
 * 16 hex chars is 64 bits — collision-proof enough for a cache of images.
 */
export function recipeOgFingerprint(model: RecipeOgModel): string {
  const payload = JSON.stringify({ v: OG_LAYOUT_VERSION, model });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Try to pull the hero image down as a data URI. ANY failure — timeout, size
 * cap, non-2xx, a format Satori can't decode — returns null, and the layout then
 * degrades to a full-width text-only card. There is deliberately no placeholder:
 * an empty grey image box looks broken in a link preview, while a wide typographic
 * card looks intentional.
 *
 * jpeg/png only: Satori's image decoder has no webp or avif support, and an
 * undecodable data URI throws mid-render rather than degrading.
 */
async function fetchHeroDataUri(heroUrl: string | null): Promise<string | null> {
  if (!heroUrl) return null;
  try {
    const { safeFetchBytes } = await import("#/lib/net/safe-fetch");
    const res = await safeFetchBytes(heroUrl, { timeoutMs: 1500, maxBytes: 2_000_000 });
    const mime = (res.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (mime !== "image/jpeg" && mime !== "image/png") return null;
    return `data:${mime};base64,${Buffer.from(res.bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Alfa Slab One is a heavy display face; the same box holds a three-word title
 * and a restaurant-menu sentence, so the size steps down as the string grows
 * rather than wrapping into the description's space.
 *
 * A hero image takes 436px of the card's 1036px, and the text column that's left
 * wraps a title into roughly half again as many lines — so every step drops when
 * there's a picture beside it. Without that the footer gets pushed off the
 * bottom edge of a card with a long title AND a photo.
 */
function titleSize(title: string, hasHero: boolean): number {
  if (title.length <= 28) return hasHero ? 64 : 76;
  if (title.length <= 60) return hasHero ? 52 : 60;
  return hasHero ? 42 : 46;
}

/**
 * Build the element tree. Intrinsic `div`/`span` only, no components: Satori
 * resolves function components through its own renderer and the extra layer buys
 * nothing here. Every element with more than one child carries an explicit
 * `display: "flex"` — Satori implements flexbox and nothing else, so a missing
 * one silently stacks children on top of each other.
 */
function ogElement(model: RecipeOgModel, heroDataUri: string | null) {
  const hasHero = heroDataUri != null;
  const title = clamp(model.title, 72);
  const size = titleSize(title, hasHero);
  // Satori won't tell us where it broke the lines, so estimate: Alfa Slab One
  // runs a bit over half an em per character, and the text column is the card
  // minus the hero when there is one. Past 60 characters, or past three lines,
  // the title has eaten the description's room — drop the sentence rather than
  // let it shove the footer off the bottom edge.
  const titleLines = Math.ceil((title.length * size * 0.62) / (hasHero ? 600 : 1036));
  const description = model.description && title.length <= 60 && titleLines <= 3 ? clamp(model.description, hasHero ? 96 : 120) : null;
  const sourceLabel = model.sourceLabel ? clamp(model.sourceLabel, 46) : null;

  return (
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        padding: 36,
        backgroundColor: BRAND.cream,
        fontFamily: "Rubik",
      }}
    >
      {/* The framed panel from public/og-image.svg: paper on cream, thick ink
          outline, hard offset shadow that lands inside the root padding. */}
      <div
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          backgroundColor: BRAND.paper,
          border: `6px solid ${BRAND.ink}`,
          borderRadius: 24,
          boxShadow: `12px 12px 0 ${BRAND.ink}`,
          padding: 40,
          gap: 36,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            justifyContent: "space-between",
            // With space-between the gap is a *floor*, not the spacing: it keeps
            // a dense card (long title, description, four chips) from letting the
            // description touch the chips, and the extra room on a sparse card
            // still spreads out.
            gap: 18,
          }}
        >
          {/* Head group: source, title and description travel together. It takes
              the slack so a card with little to say centres its title instead of
              stranding it against the top edge. */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 16 }}>
            {sourceLabel ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
                {model.sourceKicker ? <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 3, color: BRAND.mutedInk }}>{model.sourceKicker}</div> : null}
                {/* Butter pill — the sticker moment, same construction as Badge. */}
                <div
                  style={{
                    display: "flex",
                    backgroundColor: BRAND.butter,
                    border: `3px solid ${BRAND.ink}`,
                    borderRadius: 999,
                    padding: "10px 20px",
                    fontSize: 26,
                    fontWeight: 700,
                    color: BRAND.ink,
                  }}
                >
                  {sourceLabel}
                </div>
              </div>
            ) : null}
            <div style={{ fontFamily: "Alfa Slab One", fontSize: size, lineHeight: 1.05, color: BRAND.ink }}>{title}</div>
            {description ? <div style={{ fontSize: 26, lineHeight: 1.3, color: BRAND.mutedInk }}>{description}</div> : null}
          </div>

          {model.facts.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {model.facts.map((fact) => (
                <div
                  key={fact}
                  style={{
                    display: "flex",
                    backgroundColor: BRAND.cream,
                    border: `2px solid ${BRAND.ink}`,
                    borderRadius: 10,
                    padding: "6px 14px",
                    fontSize: 22,
                    fontWeight: 700,
                    color: BRAND.ink,
                  }}
                >
                  {fact}
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            {/* Wordmark with the crocker-red period, as on the static OG image. */}
            <div style={{ display: "flex", fontFamily: "Alfa Slab One", fontSize: 34, color: BRAND.ink }}>
              Buttery<span style={{ color: BRAND.red }}>.</span>
            </div>
            {model.publishedBy ? <div style={{ fontSize: 22, color: BRAND.mutedInk }}>{clamp(model.publishedBy, 34)}</div> : null}
          </div>
        </div>

        {/* Hero only when we actually have bytes — see fetchHeroDataUri. The
            slight rotation is the sticker physics of the kit, held still.
            The photo is an <img> inside a clipping frame rather than a
            `background-image`: Satori paints backgrounds as an SVG <pattern>
            and mis-sizes `background-size: cover` against a flex-sized box,
            which leaves a landscape photo drawn as a narrow strip. `object-fit`
            on a real element crops correctly at any source aspect ratio. */}
        {heroDataUri ? (
          <div
            style={{
              display: "flex",
              width: 400,
              alignSelf: "stretch",
              borderRadius: 20,
              border: `5px solid ${BRAND.ink}`,
              boxShadow: `8px 8px 0 ${BRAND.ink}`,
              overflow: "hidden",
              transform: "rotate(1.5deg)",
            }}
          >
            {/* alt is meaningless in a rasterised image (og:image:alt carries the
                description instead) but keeps a11y lint honest. */}
            <img src={heroDataUri} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Render the 1200×630 PNG. Never throws for a missing or slow hero image.
 *
 * Satori's default `embedFont: true` converts every glyph to a path, so the SVG
 * it hands resvg is self-contained and resvg is told not to go looking for system
 * fonts — the output is byte-identical on a laptop and on a container with no
 * fontconfig at all.
 */
export async function renderRecipeOgPng(model: RecipeOgModel): Promise<Buffer> {
  const [{ default: satori }, { Resvg }, heroDataUri] = await Promise.all([import("satori"), import("@resvg/resvg-js"), fetchHeroDataUri(model.heroUrl)]);

  const svg = await satori(ogElement(model, heroDataUri), {
    width: 1200,
    height: 630,
    fonts: ogFonts(),
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();

  return png;
}
