import { describe, expect, it } from "vitest";
import { ALLOWED_IMAGE_MIME, sniffImageMime } from "./recipe-image.ts";

/**
 * `sniffImageMime` exists because a `content-type` header is a third party's
 * claim about bytes we are about to store and later hand a PDS as a blob. The
 * case that motivated it is the one asserted first below: a CDN with hotlink
 * protection answers `200 image/jpeg` and puts an HTML refusal page in the body.
 *
 * So these tests are not "does it recognise a JPEG" — they are "is the verdict
 * the BYTES' verdict". Every accepted format is pinned so the allowlist and the
 * signature table cannot drift apart, and every rejection is a specific thing
 * that has been seen arriving labelled as an image.
 */

/** Pad a signature out past the function's 12-byte floor, the way a real file would be. */
function withSignature(...head: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(head);
  return bytes;
}

/** ASCII bytes — the container tags this sniffs on are all ASCII four-character codes. */
function ascii(text: string, total = Math.max(text.length, 64)): Uint8Array {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * A RIFF container: the `RIFF` tag, a four-byte little-endian payload size, then
 * the FORM TYPE at offset 8 — the field that decides what the container holds.
 * Built numerically because the size bytes are NULs, which have no business
 * being in a source file.
 */
function riff(formType: string): Uint8Array {
  const bytes = ascii(`RIFF????${formType}`);
  bytes.set([0x38, 0x00, 0x00, 0x00], 4);
  return bytes;
}

/** An ISO-BMFF header: a box length, `ftyp` at offset 4, and the brand that decides what it is. */
function isoBmff(brand: string): Uint8Array {
  const bytes = ascii(`????ftyp${brand}`);
  bytes.set([0x00, 0x00, 0x00, 0x18]);
  return bytes;
}

describe("sniffImageMime — the accepted formats", () => {
  // One case per member of `ALLOWED_IMAGE_MIME`. If a format is added to the
  // allowlist with no signature, the coverage assertion at the bottom of this
  // block fails and names it.
  const accepted: ReadonlyArray<readonly [string, string, Uint8Array]> = [
    ["a JPEG's SOI marker", "image/jpeg", withSignature(0xff, 0xd8, 0xff, 0xe0)],
    ["a PNG's eight-byte signature", "image/png", withSignature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["a GIF87a header", "image/gif", ascii("GIF87a")],
    ["a GIF89a header", "image/gif", ascii("GIF89a")],
    ["a RIFF container whose form type is WEBP", "image/webp", riff("WEBP")],
    ["an ISO-BMFF `avif` brand", "image/avif", isoBmff("avif")],
    ["an ISO-BMFF `avis` brand (an image sequence)", "image/avif", isoBmff("avis")],
    ["an ISO-BMFF `heic` brand", "image/heic", isoBmff("heic")],
    ["an ISO-BMFF `mif1` brand (what iOS actually writes)", "image/heic", isoBmff("mif1")],
  ];

  for (const [what, mime, bytes] of accepted) {
    it(`reads ${what} as ${mime}`, () => {
      expect(sniffImageMime(bytes)).toBe(mime);
    });
  }

  it("only ever returns a type the upload path is allowed to store", () => {
    // The return value is signed into a presigned POST and stored as the object's
    // content type, so a verdict outside the allowlist would be a type the bucket
    // policy refuses — or worse, one it accepts and we never meant to serve.
    for (const [, , bytes] of accepted) {
      const mime = sniffImageMime(bytes);
      expect(mime).not.toBeNull();
      expect(ALLOWED_IMAGE_MIME).toContain(mime as (typeof ALLOWED_IMAGE_MIME)[number]);
    }
  });

  it("covers every member of ALLOWED_IMAGE_MIME, so the allowlist cannot grow a format nothing can recognise", () => {
    const recognised = new Set(accepted.map(([, mime]) => mime));
    expect([...recognised].sort()).toEqual([...ALLOWED_IMAGE_MIME].sort());
  });
});

describe("sniffImageMime — the documents that arrive labelled as images", () => {
  it("rejects an HTML hotlink-refusal page, which is the reason this function exists", () => {
    // Verbatim shape of what `assets.bonappetit.com` and friends serve to a
    // request they do not like: HTTP 200, `content-type: image/jpeg`, and a page.
    // Believing the header here would store a document as a photo and only fail
    // much later, on a PDS that cannot decode the blob.
    expect(sniffImageMime(ascii("<!doctype html>\n<html><head><title>403 Forbidden</title></head><body>Hotlinking is not permitted.</body></html>"))).toBeNull();
    expect(sniffImageMime(ascii('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html><body>Access denied</body></html>'))).toBeNull();
    expect(sniffImageMime(ascii("<html><body>no</body></html>"))).toBeNull();
  });

  it("rejects an SVG, which is a scriptable document and deliberately absent from the allowlist", () => {
    // `image/svg+xml` is not in `ALLOWED_IMAGE_MIME` on purpose: an SVG can
    // script, and these bytes are third-party and get served back under our own
    // authorization. A sniffer that "helpfully" recognised it would reopen that.
    expect(sniffImageMime(ascii('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'))).toBeNull();
    expect(sniffImageMime(ascii('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it("rejects a RIFF container that is not WEBP, so the outer container is never enough", () => {
    // `RIFF` alone is shared with WAV, AVI and several others. The form type at
    // offset 8 is the only thing that makes it an image, so a sniff that stopped
    // at the four magic bytes would store audio as `image/webp`.
    expect(sniffImageMime(riff("WAVE"))).toBeNull();
    expect(sniffImageMime(riff("AVI "))).toBeNull();
  });

  it("rejects an ISO-BMFF file whose brand is not an image, so `ftyp` alone is never enough", () => {
    // AVIF, HEIC and MP4 are the same container. The brand is the whole verdict.
    expect(sniffImageMime(isoBmff("isom"))).toBeNull();
    expect(sniffImageMime(isoBmff("mp42"))).toBeNull();
    expect(sniffImageMime(isoBmff("qt  "))).toBeNull();
  });

  it("rejects other things a URL commonly yields — a PDF, JSON, plain text", () => {
    expect(sniffImageMime(ascii("%PDF-1.7\n%%EOF"))).toBeNull();
    expect(sniffImageMime(ascii('{"error":"forbidden"}'))).toBeNull();
    expect(sniffImageMime(ascii("Not Found"))).toBeNull();
  });
});

describe("sniffImageMime — inputs that are not a whole file", () => {
  it("returns null for empty bytes rather than throwing", () => {
    // The caller is a fetch that may have been capped, refused or served nothing;
    // a throw here would turn a missing photo into a failed import.
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });

  it("returns null for bytes too short to hold any signature, rather than reading past the end", () => {
    // Each of these is a real signature's prefix. `tag()` indexes without bounds
    // checks, so the length floor is what keeps a truncated body from producing
    // `undefined`-derived garbage instead of a verdict.
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImageMime(ascii("GIF89a", 6))).toBeNull();
    expect(sniffImageMime(ascii("RIFF", 4))).toBeNull();
    expect(sniffImageMime(riff("WEBP").subarray(0, 11))).toBeNull();
    expect(sniffImageMime(isoBmff("avif").subarray(0, 8))).toBeNull();
  });

  it("returns null for all-zero bytes, the shape of a body that was allocated and never filled", () => {
    expect(sniffImageMime(new Uint8Array(1024))).toBeNull();
  });

  it("never throws on any prefix of a valid image, however short", () => {
    // Property over the whole truncation range: the only two outcomes are the
    // real mime and null. A partially delivered image must not crash the copy.
    const png = withSignature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    for (let length = 0; length <= png.length; length++) {
      const mime = sniffImageMime(png.subarray(0, length));
      expect(mime === null || mime === "image/png").toBe(true);
    }
  });
});
