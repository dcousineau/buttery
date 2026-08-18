/**
 * Renders the maskable PWA icons from `services/web/public/favicon.svg`.
 *
 * Android (and increasingly other launchers) masks a `purpose: "maskable"` icon
 * to whatever shape the platform uses — circle, squircle, rounded square, teardrop
 * — and only guarantees the inner **80% circle** survives. The shipped
 * `logo192.png` / `logo512.png` are the favicon artwork with its own rounded
 * corners baked in, so a launcher rounds an already-rounded square and the result
 * letterboxes: brand-cream corners cut off inside a darker ring.
 *
 * The fix is mechanical, which is why this is a script rather than a hand-drawn
 * asset: take the same artwork, drop its `rx` corner radius so the background
 * bleeds to every edge, and scale the drawing to 80% about the centre so all of
 * it lands inside the safe zone. The output is deterministic, so re-running this
 * on an unchanged source produces byte-identical PNGs.
 *
 *   node --experimental-strip-types scripts/build-maskable-icons.ts
 *
 * Re-run it whenever `favicon.svg` changes. The PNGs it writes are generated
 * artifacts — edit the SVG, not them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "services/web/public");

/** Brand cream — the favicon's own background, now bleeding to the edges. */
const BACKGROUND = "#FFF3D8";

/**
 * The share of the canvas the artwork occupies. 0.8 is the maskable safe zone
 * exactly; nothing outside it is guaranteed to be visible on any launcher.
 */
const SAFE_ZONE = 0.8;

const SIZES = [192, 512] as const;

function maskableSvg(): string {
  const source = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");

  // The artwork lives inside `<g id="image">…</g>`; everything before it is the
  // header + `<defs>`, which have to stay where they are.
  const open = source.indexOf('<g id="image"');
  const close = source.lastIndexOf("</svg>");
  if (open === -1 || close === -1) throw new Error('favicon.svg is not the shape this script expects — check the <g id="image"> wrapper.');

  const head = source.slice(0, open);
  const body = source.slice(open, close);

  // Scale about the centre: translate by half the removed size, then scale.
  const offset = (512 * (1 - SAFE_ZONE)) / 2;

  return [
    head,
    `<rect x="0" y="0" width="512" height="512" fill="${BACKGROUND}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${SAFE_ZONE})">`,
    body,
    "</g>",
    "</svg>",
  ].join("\n");
}

const svg = maskableSvg();
writeFileSync(join(PUBLIC, "icon-maskable.svg"), svg);

for (const size of SIZES) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(join(PUBLIC, `icon-maskable-${size}.png`), png);
  console.log(`wrote icon-maskable-${size}.png (${png.byteLength} bytes)`);
}
