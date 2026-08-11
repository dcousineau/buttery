/**
 * Brand fonts for the OG image renderer, as raw font bytes Satori can shape.
 *
 * The files in `./fonts/` are the same two faces the app itself uses (docs/BRAND.md
 * — Alfa Slab One for display, Rubik for everything else), vendored as TrueType.
 * Vendored rather than fetched from Google Fonts at render time on purpose:
 *   - Satori cannot read woff2, which is all the Google Fonts CSS API serves to a
 *     modern user agent — pulling TTF requires spoofing an ancient UA string.
 *   - An OG render must not depend on a third-party network hop that can be slow,
 *     rate-limited or down. Same image bytes on every host, forever.
 * Both families are SIL Open Font License 1.1; see `fonts/LICENSE.md`.
 *
 * `?inline` makes Vite hand us a base64 data URI in dev AND in the built server
 * bundle, so there is no filesystem path to keep alive across `vite build` — the
 * bytes ride inside the module. This module is server-only (it is ~400 KB of
 * font); never import it from a component.
 */
import alfaSlabOneRegular from "./fonts/AlfaSlabOne-Regular.ttf?inline";
import rubikRegular from "./fonts/Rubik-Regular.ttf?inline";
import rubikBold from "./fonts/Rubik-Bold.ttf?inline";

/** Satori's `Font` shape, restated so this module doesn't import satori's types. */
export interface OgFont {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

function decode(dataUri: string, label: string): Buffer {
  const comma = dataUri.indexOf(",");
  // A non-data URI means Vite emitted a file reference instead of inlining —
  // fail loudly at boot rather than shipping an image with no glyphs in it.
  if (!dataUri.startsWith("data:") || comma === -1) {
    throw new Error(`[og] ${label} did not inline as a data URI (got "${dataUri.slice(0, 32)}…")`);
  }
  return Buffer.from(dataUri.slice(comma + 1), "base64");
}

let cached: OgFont[] | undefined;

/** The font set passed to Satori. Decoded once per process. */
export function ogFonts(): OgFont[] {
  cached ??= [
    { name: "Alfa Slab One", data: decode(alfaSlabOneRegular, "Alfa Slab One"), weight: 400, style: "normal" },
    { name: "Rubik", data: decode(rubikRegular, "Rubik 400"), weight: 400, style: "normal" },
    { name: "Rubik", data: decode(rubikBold, "Rubik 700"), weight: 700, style: "normal" },
  ];
  return cached;
}
