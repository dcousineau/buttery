import { useEffect, useRef, useState } from "react";

/**
 * A drop-in `<img>` that renders `fallback` instead of a broken image.
 *
 * Every surface that shows a recipe photo had already written the same
 * conditional by hand — `src ? <img …/> : <placeholder/>` — and every one of
 * them only covered the *absent* case. A URL that is present but 404s (a PDS
 * that moved, a blob evicted from storage, a laptop offline) still rendered the
 * browser's broken-image glyph. This collapses both cases into one prop.
 *
 * The fallback shows when ANY of these hold:
 *   * `forceFallback` is true      — the caller already knows (offline, a failed
 *                                    fetch, an image the user has not uploaded)
 *   * `src` is null / undefined / ""  — nothing to load
 *   * the load failed             — `onError`, plus the SSR case below
 *
 * Every other `<img>` attribute passes straight through, `onError` included:
 * the caller's handler still fires, it just runs after the fallback is armed.
 *
 * `alt` is REQUIRED, which a raw `<img>` does not enforce. `jsx-a11y/alt-text`
 * only inspects literal `<img>` elements, so wrapping one in a component would
 * quietly switch that rule off everywhere this is used. Requiring it in the type
 * puts the check back where the lint used to be. `alt=""` remains the right
 * answer whenever adjacent text already names the picture.
 */
export type ImgProps = Omit<React.ComponentProps<"img">, "src" | "alt" | "children"> & {
  /** Absent / empty renders `fallback` rather than an `<img>` with no source. */
  src?: string | null;
  /** Required on purpose — see the component note. `""` for decorative images. */
  alt: string;
  /** Rendered in place of the image. Omitted means render nothing. */
  fallback?: React.ReactNode;
  /** Skip the image outright, however healthy `src` is. */
  forceFallback?: boolean;
};

export function Img({ src, alt, fallback = null, forceFallback = false, onError, ...props }: ImgProps) {
  // Which src failed, not merely THAT one did. A boolean would pin the fallback
  // in place after the caller swaps in a working URL — a retry button, a
  // re-fetch, a carousel moving to the next photo — and the only escape would be
  // for every call site to remember to `key` this component by its src.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = ref.current;
    // An image that finished — and failed — before React attached its handler
    // never fires `onError`, so the fallback would never appear. That is the
    // ORDINARY case here, not a corner one: pages are server-rendered, so the
    // browser starts fetching from the HTML and a dead URL routinely settles
    // before hydration. `complete` with a zero `naturalWidth` is the DOM's
    // record of exactly that, and it is the only way to read it after the fact.
    if (img?.complete && img.naturalWidth === 0) setFailedSrc(src ?? null);
  }, [src]);

  if (forceFallback || !src || failedSrc === src) {
    return <>{fallback}</>;
  }

  return (
    <img
      {...props}
      ref={ref}
      src={src}
      alt={alt}
      onError={(event) => {
        setFailedSrc(src);
        onError?.(event);
      }}
    />
  );
}
