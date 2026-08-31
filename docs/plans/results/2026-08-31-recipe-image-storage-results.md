# Recipe images are always ours — build log

> Task: make every recipe image that comes through Buttery — manual create, single-URL
> import, folder import — land in Buttery's own object storage. Never store the original
> image URL. On publish, pipe our stored bytes to the atproto network. Prefer the browser
> for getting the bytes, with the server as a backup. Add a local S3 to the dev stack so
> the whole path can be exercised without touching Railway.
> Branch: `claude/recipe-image-storage-uzle9j`
> Implemented 2026-08-31.

## Status

Done. There are now exactly two places a recipe image can be served from — an atproto CDN
(a blob on the author's own PDS) and Buttery's bucket — and the third case is no longer
representable rather than merely forbidden.

## What was actually broken

Three separate defects, all downstream of one schema decision.

1. **`recipe_pending_image.source_url` existed.** When the server's fetch of an imported
   hero failed, `storePendingImageSourceUrl` wrote a row with `object_key = null` and the
   third-party URL in `source_url`. That is the "never store the original image URL" rule,
   violated by the table's own shape.
2. **That column was rendered.** `getHouseholdRecipe` selected `source_url` and returned it
   as the draft's hero `url` — so a private draft's photo on `/household/recipes/$id` was
   an `<img src>` pointing at the site it was imported from. A hotlink from our page, a
   referer leak to that host on every view, and an image that breaks the day they move it.
   The publish path read the same column and re-fetched from it.
3. **Folder imports never uploaded local bytes at all.** `CommitItem` carried only
   `imageSourceUrl`, so a Paprika export's local photos — which the browser held as `File`
   handles and the server had no way to reach — were previewed in review and then thrown
   away. Every hand-photographed recipe imported with no image.

## Decisions

- **Dropped `source_url`; `object_key` and `mime` are now `not null`.** Over keeping the
  column as provenance-only with a rule not to read it. A rule not to read a column drifts,
  and this one already had. Where the recipe came from is still `recipe_attribution.url`,
  which is the provenance anyone wanted; the CDN path the photo sat behind was never that.
  Migration `1788143104839_pending_image_bytes_only` deletes the URL-only rows — they held
  no bytes and nothing could backfill them but the host that already refused us.
- **Browser first, server as backup.** Over server-only (the status quo) and over
  browser-only. Neither covers the corpus alone: a browser `fetch` dies on a CDN with no
  `Access-Control-Allow-Origin`, and the server's fetch dies on hotlink protection, which
  keys on `Referer` and blocks datacenter IPs. They fail on disjoint sets of hosts. For a
  folder import there is no contest — those bytes exist only in the tab.
- **One union at the boundary.** `SaveRecipeInput.image` is now
  `{kind:"upload"} | {kind:"bytes"} | {kind:"url"}` instead of two independent fields the
  server had to disambiguate. `url` means only "we could not read these bytes, you try".
- **Publish reads the bucket and nothing else.** `publishLocalRecipe` had three image
  sources (create-time bytes, the bucket, a re-fetch from the origin); it has one. Every
  write path lands bytes in `pending/<recipeId>` first, so what reaches a user's PDS is
  always the object we stored.
- **Mime is sniffed, never believed.** The stored mime becomes the PDS blob's encoding and
  the proxy route's `Content-Type`, so it is derived from magic bytes at every entry point.
  This also rejects what a refusing host actually serves — an HTML interstitial with a 200 —
  and excludes SVG by omission (the sniffer is an allowlist).
- **Staged uploads are partitioned by `sha256(did)`, not the DID.** Two independent reasons,
  either sufficient: a `:` in an S3 object key fails the SigV4 signature check against
  `local-s3` and surfaces as `AccessDenied` (`%` fails identically, so escaping is not a
  fix — probed with four keys through one client, only the `:`/`%` ones failed), and a raw
  DID in a key publishes a user identifier to anything that can list the bucket.
- **A proxy route, not a presigned URL,** for reading a draft's hero. The object is private
  household data; a presigned URL is a bearer token in a query string that outlives the page
  it was minted for, and the proxy means the bucket needs no public reachability. Images are
  ≤1 MB by the lexicon's cap, so the round trip is bounded by construction.
- **`local-s3` in the dev stack**, replacing the 2026-08-12 decision to keep `BLOB_S3_*`
  pointed at the shared Railway bucket. That decision was right when this was a narrow
  pre-publish feature; it is now the whole image path, so a laptop that cannot reach a
  bucket cannot exercise it. `local-s3` over MinIO: one binary, one env var, bucket created
  by an API call on boot, no cluster and no IAM. Cost is path-style-only routing, hence
  `BLOB_S3_FORCE_PATH_STYLE` — a local-dev knob; Railway's buckets are virtual-hosted and
  leave it unset.

## Shape

Server:

- `src/server/recipe-images.ts` — new. The one door: key derivation, byte sniffing, the
  three store paths, the single read the publish path and the proxy route share.
- `src/routes/api/recipe-image/staged.ts` — `POST`, raw bytes in, opaque `uploadId` out.
  A route rather than a server function because the payload is bytes; base64 in a JSON
  envelope is a third larger. The id is only redeemable by the account that uploaded it —
  the server rebuilds the key from the _session's_ DID.
- `src/routes/api/recipe-image/$recipeId.ts` — `GET`, the draft's hero from our bucket,
  gated on box membership. An id the caller cannot see is a 404, never a 403.
- `recipes-write.ts` / `recipe-import.ts` — both now call one `storeRecipeImage`.

Client:

- `src/lib/recipe-image-upload.ts` — the CORS fetch and the staged PUT. Everything returns
  null rather than throwing: a photo may go missing, an import may not.
- `src/lib/recipe-import/stage-images.ts` — the per-chunk staging pass. Per chunk, not once
  up front, for the same reason the commit is chunked: a resumable import must not redo work
  for chunks that already landed.
- `image-cache.ts` grew `file(path)` — the review pane's `File` handles are now also what
  the commit uploads.

## Verification

- `pnpm test` — 574 passed in web, all packages green.
- `pnpm typecheck`, `oxlint` (0 errors), `oxfmt --check` — clean.
- DB suites against a real Postgres **and a real bucket** (`local-s3`): 282 passed,
  including the new `saveRecipe — the image is always OURS` block. Those tests read the
  bucket back rather than trusting the row, cover the staged-claim path end to end, and
  assert that an upload id belonging to another account resolves to nothing.
- `recipe_pending_image — the schema has no room for someone else's URL` asserts the column
  list from `information_schema`. That is the guard that goes red if the class returns: the
  bug was never one line of code, it was a column three call sites could independently
  decide to use.

## Not covered

The PDS blob upload inside `publishLocalRecipe` is still not exercised end to end — it needs
an OAuth session against the local dev-env PDS, which this environment has no way to drive
(the Playwright MCP server did not connect this session). It was equally uncovered before
this change. What is now pinned is the seam it reads through: `readPendingImage` is the
publish path's only image source, and a DB test asserts it hands back exactly the bytes and
mime that were stored.

Unclaimed `staged/` objects are garbage collected by nothing today. ULIDs sort by time, so
the intended cleanup is an expiry lifecycle rule on the prefix; Railway buckets do not expose
lifecycle rules through IaC, so it is documented in `.railway/railway.ts` rather than
declared.
