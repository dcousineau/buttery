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

---

## 2026-09-02 — the bytes stop passing through the server

> Follow-up on the same branch. Task: use presigned uploads (Railway's documented mechanism)
> instead of an upload route, cap a photo at 2 MB (Bluesky's current blob limit), serve
> pre-publish heroes with signed bucket URLs instead of a proxy, and delete as much of the
> code above as that allows.

### What went

Every byte-handling path on the server. `src/server/recipe-images.ts` (289 lines),
`POST /api/recipe-image/staged`, `GET /api/recipe-image/:recipeId`, `src/lib/pending-image.ts`,
`putBlob`, the magic-byte sniffer, and the server-side SSRF-guarded image fetch. What replaced
them is one server function that signs a form, and three small helpers on `recipes-write.ts`
that point a recipe at an object, read it for publish, and drop it.

`SaveRecipeInput.image` went from a three-armed union (`upload` | `bytes` | `url`) to
`{ uploadId, alt? }`. `CommitItem.imageSourceUrl` is gone; only `imageUploadId` remains.

### Decisions

- **Presigned POST, and MinIO in the dev stack instead of `local-s3`.** Measured, one client
  against both emulators: `local-s3` refuses a presigned POST (403 `AccessDenied`) _and_
  answers 403 to an unsigned `OPTIONS`, so no browser upload of any kind reaches it — the
  signature check is never even the thing that fails. MinIO does presigned POST, presigned
  GET, and sends permissive CORS preflight headers out of the box. The 2026-08-31 entry
  picked `local-s3` over MinIO for "one binary, no cluster, no IAM"; `minio server /data` is
  also one container, and that reason does not survive the requirement that a laptop
  exercise the real upload path.
  - A presigned PUT with signed `content-type`/`content-length` was tried first and works on
    both emulators, but it does not fix CORS, so it bought nothing — and POST is the
    mechanism Railway documents.
- **The 2 MB cap lives in the POST policy, not in a check.** `content-length-range` is
  enforced by the bucket on the body itself, so a client that lies about `size` when asking
  for a form gets a form that will not take the bytes (verified: 2 000 001 bytes is
  `EntityTooLarge`). The same policy pins `$key` and `$Content-Type` — a re-keyed or
  re-typed POST is `AccessDenied` — which is what makes a stolen form useless against
  another account's prefix.
- **The mime is declared and pinned, not sniffed.** Superseding "mime is sniffed, never
  believed", which was true when the server held the bytes and is unavailable now that it
  does not. The client names a type from a fixed allowlist (`image/svg+xml` deliberately
  absent), the policy binds the upload to it, and the save takes the authoritative value
  back off a `HeadObject` rather than from the request. A signature is a stronger promise
  than a header.
- **No server-side URL fetch any more.** It was already documented as the losing fetcher —
  hotlink protection blocks datacenter IPs far more often than it blocks a browser — and it
  was the only remaining reason for `putBlob`, the sniffer and the third union arm. An
  imported hero the tab cannot read cross-origin is now a recipe with no photo. That is a
  real regression for CORS-less hosts, taken deliberately.
- **The object never moves.** `uploads/<sha256(did)>/<ulid>` is where the browser writes it
  and where it stays; the row records that key. The previous design copied it to
  `pending/<recipeId>` — a get and a put through this server's memory to buy a key shape
  nothing reads. One prefix now, and it is still the handle for the expiry lifecycle rule.
- **Signed GET instead of a proxy route.** The proxy's authorization is not lost: a signed
  URL is only ever minted inside `listHouseholdRecipes` / `getHouseholdRecipe`, after the
  same household check the route ran. What is lost is a megabyte of memory and egress per
  view. The trade is that the URL is a bearer token for an hour, which is why nothing but
  those two authorized readers can mint one.

### Verified

- Unit suites: 562 passed, 281 skipped (no database).
- DB suites against a real Postgres **and a real MinIO bucket**: 281 passed. The image suite
  now does what a browser does — asks for a form, POSTs it, hands the save the id — so what
  is pinned is the real upload path. Three separate assertions that the policy, not the
  server, is what refuses an over-sized, re-typed or re-keyed upload.
- `tsc --noEmit` clean; `oxlint` clean (three pre-existing React warnings elsewhere).

### Not covered

The PDS blob upload inside `publishLocalRecipe`, still — it needs an OAuth session against
the dev-env PDS. Unchanged from the entry above.

Railway bucket **CORS is not configured by this branch** and the browser upload will not work
in production until it is: Railway buckets do not expose a CORS policy through IaC, so it has
to be set out of band (`aws s3api put-bucket-cors --endpoint-url <ENDPOINT>`) to allow the
app's origin for `POST` and `GET`. Noted in `.railway/railway.ts` beside the bucket.

---

## 2026-09-02b — `source_url` comes back, demoted

> Task: undo the drop of `source_url` by amending the existing migration rather than adding
> a new one, and decide whether it can stay as an attribution log without much new code.

### The reframing

The 2026-08-31 entry above says the fix was deleting the column. That was wrong about which
half was load-bearing. The defect was that **`object_key` was nullable** — that is what made
"no bytes, someone else's URL instead" a row the table would accept, and only once it was
acceptable did three call sites write it and a read path render it. Deleting `source_url` was
one way to make that unrepresentable; requiring `object_key` is another, and it is the one
that does not throw away the information.

So `1788143104839_pending_image_bytes_only` no longer drops the column. It still deletes the
URL-only rows and still tightens `object_key` and `mime` to `not null`, which is the whole
invariant: **a row that exists is a row with our bytes behind it.** With that in place
`source_url` cannot be a substitute for bytes — there is no state where it is the image — so
it is what is left over: a note on where the bytes we hold came from.

### Cost of keeping it populated

Four lines of plumbing, all of it code this branch had already written and then deleted:
`RecipeImageInput.sourceUrl`, one field on the insert, `CommitItem.imageSourceUrl` back on the
import wire, and the create form passing the origin URL once the upload succeeds. It rides
along _with_ the upload id and never without it, which is what keeps the fallback from
growing back.

The schema guard changed shape with it. It used to assert "no URL-shaped column"; it now
asserts the not-null constraints and that `source_url` is nullable — the constraint is the
difference between a log and a fallback, so the constraint is the thing to pin. A second test
saves a recipe with a source URL and reads the row back.

### Open question

`clearPendingImage` deletes the row at publish, so **the log lives only as long as the recipe
is unpublished.** That may be fine — after publish the image is the author's own blob on their
own PDS, and where we originally fetched it is moot — or it may be the exact moment the log
becomes interesting. Making it survive needs a home `clearPendingImage` does not reach (a
column on `recipe_image`, or a `recipe_meta` row), which is a new migration and past what this
change was scoped to. Flagged rather than guessed.

---

## 2026-09-02c — the dev bucket again: MinIO is archived, and ministack cannot hold the design

> Task: MinIO has been deprecated; use ministack instead.

### The premise was right

MinIO's community edition went into maintenance mode in December 2025, stopped publishing
Docker images in October 2025, and the repository was formally archived on 2026-04-25. The
`minio/minio:latest` this branch pinned an hour earlier is an unmaintained image that upstream
no longer builds. It had to go.

### ministack cannot replace it here

Probed with one client against the six behaviours the upload path actually depends on:

|                                         | ministack                              | RustFS              |
| --------------------------------------- | -------------------------------------- | ------------------- |
| POST policy `eq $key` enforced          | **204 — accepts any key**              | 400                 |
| POST policy `eq $Content-Type` enforced | **204 — stored as `text/html`**        | 400                 |
| `content-length-range` (the 2 MB cap)   | 400                                    | 400                 |
| `HeadObject`                            | 64b `text/html`                        | 64b `image/jpeg`    |
| Presigned GET                           | 200                                    | 200                 |
| Unsigned GET refused                    | **200, and the bucket lists publicly** | 403                 |
| CORS preflight                          | `*`                                    | via `PutBucketCors` |

The two rows in bold are not cosmetic. `eq $key` and `eq $Content-Type` are the entire
authorization of a presigned form: without them a form we signed for one account's prefix is a
write-anywhere credential, and the stored content type — which becomes the PDS blob's encoding
— is whatever the uploader felt like. And an unsigned `GET` returning 200 means every private
draft photo is world-readable, which is the read model deleted rather than emulated. Local dev
would have stopped exercising both properties, and
`the signed form itself refuses a body the policy does not allow` goes red against it.

SeaweedFS was measured too: it 403s every presigned POST without additional S3 auth
configuration, so it is not a drop-in either.

### RustFS

Apache 2.0, actively maintained, and it passes all six. One difference from MinIO, and it is
an improvement: **RustFS is not permissively CORS-open by default.** A bucket CORS rule has to
be configured, which is the correct S3 behaviour and exactly what Railway's buckets need. So
`scripts/create-bucket.mjs` now puts the rule on at boot (origin from `VITE_APP_URL`, `GET` and
`POST`), and the requirement the previous entry listed under "before this works in production"
is now something local dev proves rather than something production alone discovers. That call
is fatal if it fails, deliberately: a bucket with no rule is a bucket every browser upload dies
against with nothing in any server log.

Caveat worth knowing: RustFS is at 1.0.0-beta. It is a dev-stack emulator, not production
storage — production is Railway's bucket — so the exposure is a developer's laptop.

### Verified

Booted a fresh RustFS container and ran `scripts/create-bucket.mjs` against it exactly as
`pnpm dev` does (twice, for idempotence), then re-probed all six through the configured bucket:
all pass, and preflight returns `Access-Control-Allow-Origin: http://127.0.0.1:3000` for the
app's origin and 403 for anything else. DB suites against a real Postgres and that bucket: 282
passed. Unit: 562. `tsc` and `oxlint` clean.
