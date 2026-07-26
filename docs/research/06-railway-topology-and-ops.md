# Railway Topology, Cost & Ops

Verified 2026-07-25 against Railway docs and the Bluesky Tap deploy guide.

---

## 1. Recommended service topology

### Stage 1 — launch (~$7–12/mo)

```
buttery-web       TanStack Start, nitro/vite → .output/server/index.mjs, Node 22
                  public custom domain (REQUIRED — see §4)
                  no volume, horizontally scalable
buttery-cron      same repo, different startCommand
                  cronSchedule: "*/15 * * * *"  (UTC; 5-min minimum)
                  listReposByCollection + listRecords reconciliation sweep
                  MUST exit when done
postgres          Railway Postgres + volume, reached over the private network
```

### Stage 2 — add Tap (+~$5–10/mo)

```
buttery-tap       ghcr.io/bluesky-social/indigo/tap:latest
                  TAP_DATABASE_URL=$DATABASE_URL      ← reuse Postgres, no 2nd volume
                  TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
                  TAP_COLLECTION_FILTERS=exchange.recipe.recipe,exchange.recipe.collection,exchange.recipe.profile
                  TAP_WEBHOOK_URL=https://buttery.app/api/ingest
                  TAP_ADMIN_PASSWORD=<random>
                  TAP_LOG_LEVEL=error
                  restartPolicyType: ALWAYS
                  serverless/app-sleeping: OFF        ← see §3
                  NO public domain; reached at buttery-tap.railway.internal:2480
                  single replica
```

Webhook mode is the point: **Tap is the only stateful long-lived service; `buttery-web` stays
stateless.** If you instead use WebSocket delivery you need a dedicated `buttery-ingest` consumer
service (or fold it into `buttery-web` while single-replica — but then you can't scale the web tier).

Reusing `$DATABASE_URL` for Tap avoids a second volume and keeps you under the Hobby 5 GB volume cap.

---

## 2. Cost

Published rates:

| Resource   | Price                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| Hobby plan | $5/mo including $5 usage credit (no rollover); 5 GB volume cap, 6 replicas |
| Pro plan   | $20/mo including $20 credit                                                |
| vCPU       | **$20 / vCPU / mo**                                                        |
| RAM        | **$10 / GB / mo**                                                          |
| Volume     | $0.15 / GB / mo                                                            |
| Egress     | $0.05 / GB (**ingress not billed** — good for a firehose)                  |

Estimates `[inferred]`:

- Tap filtered to one low-volume NSID: ~0.05 vCPU avg, ~~256–512 MB RAM → **~~$4–6/mo** + small volume
  - a few GB egress. Railway's own statusphere template page cites **~$1.50/mo** for full-network
    Status aggregation, so this is likely conservative.
- Whole stack (web + Tap + Postgres): **~$9–15/mo**.

**Hobby's $5 credit will not cover three services.** Budget Pro, or ~$15–25/mo total.

**RAM at $10/GB/mo is your main lever** — SSR heap and Postgres RAM dominate, not the firehose.

---

## 3. Traps

### App-sleeping will kill your ingest worker

Railway's inactivity detection counts **outbound** packets only. A firehose consumer is almost purely
inbound, so it looks idle and gets slept. **Disable serverless/app-sleeping on `buttery-tap`.** Set
`restartPolicyType: ALWAYS` and handle SIGTERM.

### Don't set `healthcheckPath` on a portless worker

Healthchecks are deploy-time only (300 s default) — the deploy will hang. (Tap does bind `:2480` and
has `GET /health`, so it can have one; a bare WebSocket consumer cannot.)

### Volumes and replicas are mutually exclusive

**Replicas cannot be used with volumes.** Brief downtime on redeploy. Grow-only. Another reason to
point Tap at Postgres rather than giving it a volume.

### Cron specifics

5-field crontab, **UTC**, **5-minute minimum interval**. **The process must exit** or subsequent runs
are skipped. Overlapping runs are skipped. It runs the service's start command — so it's a separate
service, same repo, different `startCommand`.

### Private networking

`<service>.railway.internal` / `RAILWAY_PRIVATE_DOMAIN`, Wireguard-encrypted, plain `http://`
internally, **not billed as egress**. Use the private `DATABASE_URL` from both services — the
TCP-proxy public URL **is** billed as egress.

**IPv6-only is outdated:** environments created after 2025-10-16 are dual-stack. Legacy environments
are v6-only and need `listen(port, '::')`.

### Deploys must not reset your cursor

Tap persists its cursor to `TAP_DATABASE_URL` (`TAP_CURSOR_SAVE_INTERVAL`, default 1 s), so this is
handled — as long as you don't point it at ephemeral storage. Don't set `TAP_NO_REPLAY` in production.

---

## 4. The stable-domain constraint — read before your first user

Per the [OAuth spec](https://atproto.com/specs/oauth), `client_id` **must be** a fully-qualified
`https://` URL with **no port**, from which the metadata JSON is fetched by the user's PDS.

So `client_id` _is_ `https://<your-domain>/client-metadata.json`, which means:

> **Changing your domain changes your client identity, invalidating every session and forcing
> re-consent from every user.**

⚠️ **Attach your custom domain before your first real user.** Do not ship on `*.up.railway.app` and
migrate later. Build the URL from `RAILWAY_PUBLIC_DOMAIN`, which resolves to the custom domain once
attached.

Also: `/client-metadata.json` and `/.well-known/jwks.json` are fetched **server-to-server,
unauthenticated**. No Cloudflare Access, no bot challenge, no basic auth in front of them.

A tunnel is only needed to exercise the confidential-client path locally; ordinary loopback dev
doesn't need one.

---

## 5. Observability

Scrape Tap's stats endpoints as your lag/health signals:

| Endpoint                                       | Meaning                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /stats/outbox-buffer`                     | **Your primary lag metric.** `TAP_OUTBOX_CAPACITY` default 100,000; buffers to 1M in memory before applying backpressure. |
| `GET /stats/resync-buffer`                     | Repos currently being repaired                                                                                            |
| `GET /stats/cursors`                           | Firehose position                                                                                                         |
| `GET /stats/repo-count`, `/stats/record-count` | Coverage                                                                                                                  |
| `GET /health`                                  | Liveness                                                                                                                  |
| `TAP_METRICS_LISTEN`                           | Prometheus metrics / pprof                                                                                                |

App-side alarms worth having:

- Outbox writes stuck in `pending` beyond N minutes (a user's PDS is down, or your token broke)
- OAuth `deleted` events spiking (something is wrong with your refresh path or `requestLock`)
- Reconciliation sweep finding a growing diff (index drift — Tap or the sweep is failing)
- `auth_state` table growing unboundedly (your cleanup cron isn't running)

---

## 6. Environment variables you'll need

```bash
# web
DATABASE_URL=                          # private networking
PUBLIC_URL=https://buttery.app         # → client_id, redirect_uris, jwks_uri
PRIVATE_KEY_1= PRIVATE_KEY_2= PRIVATE_KEY_3=   # ES256 PKCS#8 PEM, rotation set
COOKIE_SECRET=
NODE_VERSION=22                        # NOT 24 — Request bug breaks the OAuth client

# tap
TAP_DATABASE_URL=                      # same Postgres
TAP_SIGNAL_COLLECTION=exchange.recipe.recipe
TAP_COLLECTION_FILTERS=exchange.recipe.recipe,exchange.recipe.collection,exchange.recipe.profile
TAP_WEBHOOK_URL=https://buttery.app/api/ingest
TAP_ADMIN_PASSWORD=
TAP_RELAY_URL=https://relay1.us-east.bsky.network
TAP_LOG_LEVEL=error
```

Generate keys with a script equivalent to Statusphere's `gen-key`.

Authenticate the webhook: Tap posts JSON to `TAP_WEBHOOK_URL`; put a shared secret in the path or
require a header, and reject anything else — that endpoint writes directly to your index.

---

## Sources

[Railway pricing](https://docs.railway.com/reference/pricing) ·
[App sleeping](https://docs.railway.com/reference/app-sleeping) ·
[Private networking](https://docs.railway.com/reference/private-networking) ·
[Tap Railway deploy guide](https://github.com/bluesky-social/indigo/blob/main/cmd/tap/RAILWAY_DEPLOY.md) ·
[Tap Railway template](https://railway.com/deploy/atproto-tap-example) ·
[Statusphere Railway template](https://railway.com/deploy/atproto-statusphere-app) ·
[OAuth spec](https://atproto.com/specs/oauth) ·
[TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)
