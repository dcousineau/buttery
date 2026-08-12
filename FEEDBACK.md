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

## Session 2 — integrating `.mcp.json` generation, and the "new" mise cloud setup

Context: pulled `chore/generate-mcp-json` (PR #27) into this branch and re-pointed
its `.mcp.json` renderer at the docker-compose world (DATABASE_URL now lives in
`services/web/.env`, not `railway run`; the postgres MCP runs inside a container,
so the host is rewritten `localhost` → `host.docker.internal`). The cloud env
setup script was updated between sessions to install mise automatically. It is
better — `mise` itself is on `PATH` now, and the login-shell `$PATH` corruption
from session 1 is gone — but mise still does **not** come up configured. Three
concrete reasons, each with a fix:

- **The setup script never `cd`s into the repo, so `mise trust` + `mise install`
  never run against it.** The script tries `cd "$HOME/workspace"` then
  `cd ./workspace`, but in a cloud session `$HOME` is `/root` while the repo is
  cloned to `/home/user/buttery` (and the setup script's own CWD is elsewhere).
  Neither branch matches, so the `mise trust` / `mise install --yes` block is
  skipped entirely. Observed fallout at session start: `mise ls` fails with
  *"Config files in /home/user/buttery/mise.toml are not trusted"* and every
  pinned tool shows `(missing)`. Fix: discover the repo dir instead of guessing
  it (script below).
- **`set -e` + `mise install --yes` aborts the whole script on the first tool
  that can't be verified.** `pnpm` (and any aqua-backed tool) fails artifact
  attestation because `tuf-repo-cdn.sigstore.dev` is proxy-blocked (403 on
  CONNECT — confirmed in `$HTTPS_PROXY/__agentproxy/status`). Under `set -e`
  that one failure kills setup before Node/pnpm finish and before any
  post-install step runs. Fix: whitelist the sigstore/GitHub hosts (below), or
  make the install non-fatal and skip attestation.
- **mise is never *activated* in the shell, so installed tools aren't on `PATH`.**
  `/etc/profile.d/` has activation scripts for node/nvm/rbenv/etc. but nothing
  for mise, and neither `~/.bashrc` nor `~/.profile` calls `mise activate`. Even
  after a successful `mise install`, `node`/`pnpm` resolve to the base image's
  `/opt/node22`, not the pinned versions. Fix: drop a `mise.sh` in
  `/etc/profile.d` that puts the mise shims on `PATH` (below).

Net effect this session: `mise run mcp:setup` triggered a full `mise install`
(node@26, railway, process-compose all installed fine — GitHub *release
downloads* and attestation for those worked), but `pnpm@11.20.0` failed
attestation and took the task down with it, so the render didn't run through
mise. Rendering `.mcp.json` directly with `node scripts/dev/render-mcp.mjs`
(the renderer only needs Node) worked every time. That's the reliable path for a
cloud boot and is what the improved setup script uses.

### Proxy-blocked domains (candidates for the egress allowlist)

Offered by the maintainer to whitelist (wildcards OK). Ordered by how much they
hurt the mise/local-dev flow:

- `*.sigstore.dev` — **confirmed 403 on CONNECT** (`tuf-repo-cdn.sigstore.dev`
  in the proxy's `recentRelayFailures`). This is the one that breaks `mise
  install`: aqua tools (`pnpm`, `railway`, `process-compose`) verify GitHub
  artifact attestations through Sigstore's TUF root here. Also covers
  `fulcio.sigstore.dev` / `rekor.sigstore.dev` if attestation is kept on.
- `github.com`, `objects.githubusercontent.com`, `codeload.github.com` — GitHub
  release **asset** downloads. Flaky rather than hard-blocked: saw intermittent
  `502 Bad Gateway` on `github.com/.../releases/download/...` (pnpm tarball),
  while railway/process-compose tarballs pulled fine moments earlier.
- `api.github.com` — mise version **resolution** (`/repos/<t>/releases`) returns
  `403` with *"GitHub access to this repository is not enabled for this
  session."* Note: this is the session's GitHub-scoping layer, not a plain
  egress rule, so a host allowlist entry may not be enough on its own — but it's
  the host mise hits for `@latest`/version listing.
- Docker registry blob hosts (carried over from session 1, still relevant for
  `redis:8.2.1` from Docker Hub): `production.cloudfront.docker.com`,
  `d2glxqk2uabbnd.cloudfront.net`, `registry-1.docker.io`, `auth.docker.io`,
  `production.cloudflare.docker.com`. `ghcr.io` already works (Postgres pulls).

### Suggested cloud env setup script (drop-in replacement)

Fixes all three mise problems above: finds the repo wherever it was cloned,
survives an un-verifiable tool, activates mise for every future shell, and
renders `.mcp.json` so the *next* session boots with the MCP servers wired up.

```bash
#!/bin/bash
set -uo pipefail   # NOT -e: a single un-verifiable tool must not abort setup

echo "=== Installing mise ==="
apt update
apt install -y gh extrepo
extrepo enable mise
apt update
apt install -y mise

echo "=== Activating mise for all future shells ==="
# The base image activates node/nvm/rbenv via /etc/profile.d but not mise, so
# installed tools never reach PATH. Put the mise shims on PATH for every shell
# (works in non-interactive shells too, unlike `mise activate`).
cat > /etc/profile.d/mise.sh <<'EOF'
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
command -v mise >/dev/null && eval "$(mise activate bash)"
EOF
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"

echo "=== Locating the cloned repo ==="
# Claude Code on the web clones under /home/user (not $HOME, which is /root),
# so the original `cd $HOME/workspace` never matched. Discover it instead.
REPO_DIR=""
for c in "$PWD" "$HOME/workspace" ./workspace /home/user/* /home/*/*; do
  if [ -f "$c/mise.toml" ] || [ -f "$c/.mise.toml" ]; then REPO_DIR="$c"; break; fi
done
[ -z "$REPO_DIR" ] && REPO_DIR="$(dirname "$(find /home -maxdepth 3 -name mise.toml 2>/dev/null | head -n1)")"

if [ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ]; then
  cd "$REPO_DIR"
  echo "=== Setting up project tools in $REPO_DIR ==="
  mise trust

  # Skip Sigstore/GitHub artifact attestation: tuf-repo-cdn.sigstore.dev is
  # proxy-blocked, which otherwise fails `pnpm`/`railway`/`process-compose`.
  # (Remove these two lines once *.sigstore.dev is on the egress allowlist.)
  mise settings set aqua.slsa false  || true
  mise settings set aqua.cosign false || true

  mise install --yes || echo "WARN: some tools failed to install (see above)"

  echo "=== Rendering .mcp.json for the next session ==="
  # Only needs Node, so it works even if pnpm/railway didn't install. Renders
  # the example's placeholder when services/web/.env is absent (the usual cloud
  # case), wiring up every MCP server except the (host-only) postgres one.
  node scripts/dev/render-mcp.mjs || echo "WARN: .mcp.json render skipped"
else
  echo "WARN: could not find the repo's mise.toml; skipped trust/install/render"
fi
```

Two caveats on the above: (1) whitelisting `*.sigstore.dev` is the cleaner fix
than the `aqua.slsa false` lines — it keeps attestation verification on for
everyone; drop those two lines once the host is allowlisted. (2) The
`node scripts/dev/render-mcp.mjs` step is what actually delivers on "MCP config
available when Claude boots"; the repo's mise `postinstall` hook also renders it,
but that runs inside `mise install` and dies with pnpm's attestation, so the
explicit call is the dependable one.
