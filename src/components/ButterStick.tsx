/**
 * The Buttery mark: a flat pop-art stick of butter. Reuse this everywhere the
 * brand needs a face — do not redraw per-page (see docs/BRAND.md).
 */
export default function ButterStick({ className, label }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 240 130" className={className} role={label ? "img" : "presentation"} aria-label={label} aria-hidden={label ? undefined : true}>
      {/* top face */}
      <polygon points="20,55 62,22 226,22 184,55" fill="var(--butter-pale)" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      {/* right end face */}
      <polygon points="184,55 226,22 226,78 184,111" fill="var(--butter-deep)" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      {/* front face */}
      <rect x="20" y="55" width="164" height="56" fill="var(--butter)" stroke="var(--border)" strokeWidth="5" strokeLinejoin="round" />
      {/* wrapper seam lines on the front */}
      <line x1="48" y1="55" x2="48" y2="111" stroke="var(--border)" strokeWidth="3" />
      <line x1="156" y1="55" x2="156" y2="111" stroke="var(--border)" strokeWidth="3" />
      <text x="102" y="90" textAnchor="middle" fill="var(--border)" style={{ font: "400 21px 'Alfa Slab One', serif", letterSpacing: "0.08em" }}>
        BUTTER
      </text>
    </svg>
  );
}
