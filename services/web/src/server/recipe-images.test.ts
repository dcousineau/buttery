import { describe, expect, it } from "vitest";
import { accountSlug, isKeySafeRecipeId, isValidUploadId, MAX_IMAGE_BYTES, pendingImageKey, sniffImageMime, stagedImageKey, validateImageBytes } from "./recipe-images.ts";

/**
 * The pure half of the image invariant.
 *
 * The module's writes need a bucket and a database (they are covered by the db
 * suites); what is testable here is the part that decides — what counts as an
 * image, and what an object key is allowed to be built from. Both are the
 * places a bad byte string or a hostile id would get in.
 */

/** A minimal header of `length` bytes starting with `prefix`. */
function header(prefix: readonly number[], length = 16): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(prefix);
  return bytes;
}

/** `....ftyp<brand>` — the ISO-BMFF shape AVIF and HEIC share. */
function isoBmff(brand: string): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  for (let i = 0; i < 4; i++) bytes[8 + i] = brand.charCodeAt(i);
  return bytes;
}

describe("sniffImageMime", () => {
  it("recognizes the formats we store", () => {
    expect(sniffImageMime(header([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageMime(header([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(sniffImageMime(header([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(sniffImageMime(isoBmff("avif"))).toBe("image/avif");
    expect(sniffImageMime(isoBmff("heic"))).toBe("image/heic");
  });

  it("rejects the thing a refusing host actually serves", () => {
    // `<!doctype html>` — a hotlink-protection interstitial, or a 200-with-a-login-wall.
    // This is the realistic failure, not a crafted payload: plenty of hosts answer an
    // image request with a page and a 200, and believing their content-type would put
    // HTML in a bucket we later serve from our own origin.
    const html = new TextEncoder().encode("<!doctype html><html><body>Hotlinking not allowed");
    expect(sniffImageMime(html)).toBeNull();
  });

  it("rejects SVG, which is a document, not a picture", () => {
    // SVG is scriptable and would be served back from our own origin. It is
    // excluded by having no magic bytes rather than by a denylist — the sniffer
    // is an allowlist, so the omission is the rejection.
    expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
  });

  it("rejects anything too short to identify", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });
});

describe("validateImageBytes", () => {
  it("returns the SNIFFED mime, so a caller's claim is never what we store", () => {
    expect(validateImageBytes(header([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.mime).toBe("image/png");
  });

  it("enforces the lexicon's 1 MB blob cap", () => {
    const oversize = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversize.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(validateImageBytes(oversize)).toBeNull();

    const atCap = new Uint8Array(MAX_IMAGE_BYTES);
    atCap.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(validateImageBytes(atCap)?.mime).toBe("image/jpeg");
  });

  it("rejects an empty body", () => {
    expect(validateImageBytes(new Uint8Array())).toBeNull();
  });
});

describe("object keys", () => {
  it("addresses a claimed image by recipe id alone", () => {
    expect(pendingImageKey("01JABCDEF0123456789ABCDEFG")).toBe("pending/01JABCDEF0123456789ABCDEFG");
  });

  it("partitions staged uploads by account, and by a HASH of the DID", () => {
    // The partition is the authorization: the wire only carries the id half, and
    // the server rebuilds the key from the SESSION's did — so an id guessed or
    // stolen from another account resolves to a key that account does not own.
    const mine = stagedImageKey("did:plc:abc", "01JABCDEF0123456789ABCDEFG");
    const theirs = stagedImageKey("did:plc:xyz", "01JABCDEF0123456789ABCDEFG");
    expect(mine).not.toBe(theirs);
    expect(mine).toBe(`staged/${accountSlug("did:plc:abc")}/01JABCDEF0123456789ABCDEFG`);
    // Stable across calls: nothing is stored, the key is re-derived per request.
    expect(stagedImageKey("did:plc:abc", "01JABCDEF0123456789ABCDEFG")).toBe(mine);
  });

  it("keeps `:` out of every key, because a colon breaks the request outright", () => {
    // Not cosmetic. The AWS SDK and local-s3 disagree on whether SigV4's
    // canonical URI percent-encodes `:`, so a key containing one fails the
    // signature check and comes back as `AccessDenied` — which reads as a
    // permissions problem and is not one. A DID is full of colons, hence the
    // hash. (`%` fails identically, so percent-escaping is not a fix.)
    expect(stagedImageKey("did:plc:abc", "01JABCDEF0123456789ABCDEFG")).not.toContain(":");
    expect(accountSlug("did:plc:abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isKeySafeRecipeId", () => {
  it("accepts a minted ULID — what every recipe with a pending image has", () => {
    expect(isKeySafeRecipeId("01JABCDEF0123456789ABCDEFG")).toBe(true);
  });

  it("refuses an rkey that would break the bucket request", () => {
    // Recipe ids ARE atproto rkeys, and an rkey may legitimately contain `:` or
    // `~`. No synced recipe has a pending image today, so this guard is about
    // turning a future caller's mistake into a refusal here rather than an
    // `AccessDenied` from S3 that says nothing about the cause.
    expect(isKeySafeRecipeId("self:main")).toBe(false);
    expect(isKeySafeRecipeId("a~b")).toBe(false);
    expect(isKeySafeRecipeId("../pending/other")).toBe(false);
    expect(isKeySafeRecipeId("")).toBe(false);
  });
});

describe("isValidUploadId", () => {
  it("accepts a minted ULID", () => {
    expect(isValidUploadId("01JABCDEF0123456789ABCDEFG")).toBe(true);
  });

  it("rejects anything that would escape its slot in the key space", () => {
    // An upload id is concatenated into an object key, so a `/` or a `..` is a
    // path traversal in the bucket's namespace — the reason this is validated on
    // the way back in rather than trusted as "we minted it".
    expect(isValidUploadId("../../pending/someone-elses-recipe")).toBe(false);
    expect(isValidUploadId("01JABCDEF0123456789ABCDE/G")).toBe(false);
    expect(isValidUploadId("")).toBe(false);
    // Crockford base32 excludes I, L, O and U; the lowercase form is not what
    // `ulid()` produces either.
    expect(isValidUploadId("01jabcdef0123456789abcdefg")).toBe(false);
    expect(isValidUploadId("01JABCDEF0123456789ABCDEFGH")).toBe(false);
  });
});
