import React from "react";

/**
 * Gingham trim. The brand rule is "trim, not wallpaper": a thin band on the
 * header's bottom edge, the footer's top edge, or a section divider — never a
 * full-page background, and never behind recipe content.
 *
 * `variant="band"` is the 14px chrome strip (7px check). `variant="field"` is the
 * larger 20px check used only if a screen genuinely wants a tablecloth moment,
 * in which case content must sit on --paper cards on top of it.
 */
export function GinghamBand({ variant = "band", className = "", style, ...rest }) {
  const cls = variant === "field" ? "gingham" : "gingham-band";
  return <div aria-hidden="true" data-slot="gingham" className={[cls, className].filter(Boolean).join(" ")} style={style} {...rest} />;
}
