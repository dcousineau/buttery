# Replace `railway dev` with a repo-owned docker-compose — build log

> Task: replace `railway dev` for local dev with a committed `docker-compose.yml`
> so local dev needs no Railway CLI access or auth. Railway stays for deploys and
> the remote blob bucket only.
> Branch: `claude/docker-compose-local-dev-o9tujj`
> Implemented 2026-08-12.

## Status

Done. `pnpm dev` now boots Postgres + Redis from a committed
[`docker-compose.yml`](../../../docker-compose.yml) instead of `railway dev up`,
migrations and the web server read their config from `services/web/.env` instead
of `railway run` injection, and the Caddy `railway-proxy` is gone entirely. No
Railway login is needed to run the stack.

## Decisions

- **Blob bucket → kept REMOTE.** `BLOB_S3_*` still points at the shared Railway
  `buttery-uploads` bucket via `.env` credentials; no MinIO was added. Rationale:
  the goal statement itself carves out "the remote blob bucket" as a thing Railway
  keeps, the compose snapshot had no local equivalent, and standing up MinIO would
  mean production-code changes to `blob-storage.ts` (path-style addressing +
  bucket bootstrap) for a narrow, pre-publish feature. The blob path is optional
  locally — the app boots and runs without the creds; only exercising draft-image
  upload/publish needs them, and it fails loudly if they're absent.
  `.env.example` documents how to get them once from the Railway dashboard.
- **Fixed ports: Postgres `55432`, Redis `56379`.** The snapshot's 33628/39966
  were Railway-assigned per-`up` and not stable. High ports were chosen over
  5432/6379 so a developer's own local Postgres/Redis on the defaults doesn't
  collide. Because the repo owns the ports now, `services/web/.env` pins them —
  the inverse of the old "never hardcode, it regenerates" rule.
- **Throwaway local credentials** (`butterydev` for both Postgres and Redis) live
  in the committed compose file and `.env.example`. These are not secrets — they
  are identical for every developer and never leave a laptop, exactly like the
  conventional `postgres:postgres`. No production value was copied anywhere.
- **Redis command kept faithful to the snapshot:** same image, same `lost+found`
  cleanup, same `redis-server --requirepass … --save 60 1 --dir …` invocation.
  The one change is the data dir — Railway threaded it through a
  `RAILWAY_VOLUME_MOUNT_PATH` env var; the repo owns the mount, so it's `/data`.
- **Env loading for the web server** is done in `vite.config.ts` via
  `process.loadEnvFile()`, mirroring what `kysely.config.ts` already does for the
  migration CLI. `railway run` was the only thing populating `process.env` with
  `DATABASE_URL`/`REDIS_URL`/`BLOB_S3_*`/the `ATPROTO_*` overrides; Vite loads
  `.env` for `VITE_`-prefixed client vars but leaves server vars untouched, so
  the server needed this. `loadEnvFile()` never overrides an already-set var, so
  CI, shell exports, and Railway still win in their environments.

## What changed

| File                                                                                                                              | Change                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml` (new)                                                                                                        | Postgres + Redis, fixed ports, named volumes, healthchecks. No caddy.                                                                                                                                                                                                                           |
| `scripts/dev/railway-containers.mjs` → `dev-containers.mjs`                                                                       | Repointed at the repo-root compose file; dropped all `~/.railway` project-id resolution and the Railway "unpublished TCP proxy port" warning.                                                                                                                                                   |
| `process-compose.yaml`                                                                                                            | `railway-dev` → `dev-containers` (`docker compose up -d --wait`, still a one-shot `restart:"no"` gate); deleted the `railway-proxy` process; dropped the `railway run --service buttery --` prefix from `migrate` and `web`; the `web` URL re-overrides are gone (`.env` is now authoritative). |
| `package.json`                                                                                                                    | `dev:down` now runs `docker compose down` instead of `railway dev down`.                                                                                                                                                                                                                        |
| `services/web/vite.config.ts`                                                                                                     | Dev-only `process.loadEnvFile()` so the server gets `.env`.                                                                                                                                                                                                                                     |
| `services/web/.env.example`                                                                                                       | Documents every var `railway run` used to inject, with the new fixed-port `DATABASE_URL`/`REDIS_URL` and the blob-bucket decision.                                                                                                                                                              |
| `README.md`, `docs/LOCAL-DEV.md`, `.agents/skills/local-dev/SKILL.md`, `AGENTS.md`, `services/atproto-dev-env/{README,AGENTS}.md` | Docs re-pointed off `railway dev`; obsolete "generated compose file / cannot be relocated / ports regenerate" narrative rewritten; added the `cp .env.example .env` first-run step.                                                                                                             |

`pnpm dev` stays the single entry point and `pnpm dev:down` still works.

## Verification

Run under Node 26.7.0 + pnpm 11.20.0:

```
docker compose config                → valid (ports 55432/56379, redis command resolves)
docker compose up -d postgres --wait → container reports Healthy; host :55432 reachable
pnpm --filter=@buttery/web db:migrate:up  → 16 migrations applied (DATABASE_URL from .env, no railway run)
pnpm -r typecheck                    → clean
pnpm lint                            → clean
pnpm format:check                    → clean
```

**What could NOT be verified here, and why:** the full `pnpm dev` boot with Redis.
This cloud session's egress proxy blocks Docker Hub / ECR-public image blobs
(served from CloudFront, answered `403`); only `ghcr.io` is reachable. The
Postgres image is on ghcr and pulled fine — hence the real Postgres boot +
migration above — but `redis:8.2.1` (Docker Hub) could not be pulled, so Redis
and everything gated on it (the `web` server) were not booted in this
environment. This is an environment limitation, not a stack defect; see
[docs/CLAUDE_CLOUD.md](../../CLAUDE_CLOUD.md). On a machine with normal Docker Hub access,
`pnpm dev` should bring the whole stack up. _(Since resolved: both registries
pull in cloud sessions and the full stack — Redis and `web` included — has been
booted and verified there.)_

## Follow-ups / notes

- `pnpm test:db` (web) and the atproto-cron-sync commands still wrap
  `railway run --service … --`; they don't self-load `.env`. Left as-is per the
  task's scope (cron-sync intentionally keeps `railway run`). A future change
  could give the vitest `db` project a `.env` loader to drop `railway run` there
  too.
- `.railway/railway.ts:30` has a stale comment referencing the old
  `scripts/dev/railway-containers.mjs` path. Left untouched because the task
  said not to touch deploy config; worth a one-line fix in a deploy-config PR.
