# Local dev / cloud environment feedback

Running notes from working this branch in a Claude Code **cloud** session. Kept
succinct; each item is a friction point plus a concrete fix suggestion.

## Environment friction hit this session

- **Docker registry is partially blocked by the egress proxy.** Docker Hub and
  ECR-public image blobs are served from CloudFront
  (`production.cloudfront.docker.com`, `d2glxqk2uabbnd.cloudfront.net`), which
  the proxy answers `403` to. `ghcr.io` works. Consequence: the Postgres image
  (ghcr) pulls fine, but `redis:8.2.1` (Docker Hub) cannot be pulled, so the
  **full stack cannot boot here** — only Postgres + migrations were bootable.
  Fix idea: allowlist the Docker Hub / ECR CloudFront blob hosts, or pre-pull
  the two dev images into the base image / a registry mirror for cloud sessions.
- **Node 26 is not available out of the box.** `package.json` pins
  `devEngines.runtime = ^26`, but the base image ships Node 20/21/22 only.
  `mise use node@26` did install `node@26.7.0`, but see the mise notes below.
  Fix idea: bake Node 26 into the cloud base image, or run `mise install` in a
  SessionStart hook (today it fails — next bullet).
- **`mise` is flaky in this environment.** `mise exec -- pnpm` panics; installing
  `pnpm` via mise fails because artifact attestation needs
  `tuf-repo-cdn.sigstore.dev` (proxy `403`) and the GitHub releases API is `403`
  for this session. The `postinstall` hook `mise run railway-skills` also fails
  (needs Railway CLI + GitHub). Workaround used: Node 26 from the mise install
  dir on PATH + `pnpm` from `/opt/node22` (it runs fine under Node 26).
- **The login shell PATH was broken** — it contained a literal `$PATH` token, so
  `git`, `node`, `pnpm`, and coreutils were all missing until PATH was rebuilt
  by hand. Worth fixing in the session bootstrap.
- **Docker daemon was not running** at session start; had to launch `dockerd`
  manually before any `docker` command worked.
- **`pnpm install --config.runtime-on-fail=ignore` mutated `package.json`** — it
  persisted `devEngines.runtime.onFail: "ignore"`. Had to revert. Prefer the
  transient `--runtime-on-fail=ignore` flag; it should not write to the manifest.
- **`gh` CLI is absent** (installed mid-session via `apt install -y gh` per the
  user). A cloud session that opens PRs benefits from `gh` (or the GitHub MCP
  tools) being present up front.

## Suggested AGENTS.md / setup docs improvements

- **Document the `.env` bootstrap as step one of local dev.** Now that `pnpm dev`
  no longer wraps the server in `railway run`, a fresh clone must:
  `cp services/web/.env.example services/web/.env` and set `BETTER_AUTH_SECRET`
  (`openssl rand -base64 32`). The `DATABASE_URL`/`REDIS_URL` defaults already
  match `docker-compose.yml`, so no other value is needed for a first boot.
  (Added to `README.md`; consider a SessionStart hook that copies the file if
  missing so web sessions don't trip over a missing `.env`.)
- **State the local-dev toolchain needs a running Docker daemon and registry
  reachability.** GHCR must be reachable for Postgres; Docker Hub for Redis.
- **A SessionStart hook could `mise install` (or verify Node 26 + pnpm)** so web
  sessions land with the pinned toolchain instead of discovering it is missing.
