import React from "react";

/**
 * The Buttery mark: a flat pop-art stick of butter. Ported verbatim from
 * services/web/src/components/ButterStick.tsx — the geometry, stroke widths and
 * fills are the source values, not a redraw. Reuse this everywhere the brand
 * needs a face; never draw a per-page variant.
 *
 * NOTE: the app's own comment calls this a PLACEHOLDER mark.
 */
export function ButterStick({ className = "", label, ...rest }) {
  return (
    <svg viewBox="0 0 240 130" className={className} role={label ? "img" : "presentation"} aria-label={label} aria-hidden={label ? undefined : true} {...rest}>
      <polygon points="20,55 62,22 226,22 184,55" fill="#ffe9a0" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      <polygon points="184,55 226,22 226,78 184,111" fill="var(--butter-deep)" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      <rect x="20" y="55" width="164" height="56" fill="var(--butter)" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      <line x1="48" y1="55" x2="48" y2="111" stroke="var(--border)" strokeWidth="3" />
      <line x1="156" y1="55" x2="156" y2="111" stroke="var(--border)" strokeWidth="3" />
      <text x="102" y="90" textAnchor="middle" fill="var(--border)" style={{ font: "400 21px 'Alfa Slab One', serif", letterSpacing: "0.08em" }}>
        BUTTER
      </text>
    </svg>
  );
}
