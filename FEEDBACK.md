# Local dev / cloud environment feedback

Running notes from working this branch in a Claude Code **cloud** session. Kept
succinct; each item is a friction point plus a concrete fix suggestion.

## Now working (previous friction, resolved this session)

Verified fixed since the last round — recorded so nobody re-investigates them:

- **Both container registries pull.** `redis:8.2.1` from **Docker Hub** now pulls
  cleanly (the CloudFront blob 403 from session 1 is gone), and
  `ghcr.io/railwayapp-templates/postgres-ssl:18.4` pulls too. The full
  docker-compose stack boots (`dev-containers` reaches healthy). _(One caveat on
  ghcr below.)_
- **The pinned toolchain installs.** `mise install` brings up node@26.7.0,
  pnpm@11.20.0, process-compose, and railway — including the aqua tools that used
  to die on Sigstore attestation. No `*.sigstore.dev` failures in the proxy's
  `recentRelayFailures` this session.
- **Login-shell PATH is intact** (no literal `$PATH` token) and **`mise` is on
  `PATH`** (`/usr/bin/mise`). The setup script's repo discovery + `mise trust` +
  `mise install` now run against the repo (`mise ls` shows every tool present, no
  `(missing)`).
- **Docker daemon is up at session start** and **`gh` is preinstalled**
  (2.45.0).
- **`.env`-driven dev works.** `cp services/web/.env.example services/web/.env` +
  a generated `BETTER_AUTH_SECRET` is all a boot needs; migrations apply and the
  app reads its config with no `railway run`.

End-to-end check this session (after the two fixes below):

- **Postgres** — reachable on `55432`, PostgreSQL 18.4, all migrations applied
  (full table set present).
- **Redis** — reachable on `56379`, `PING`/`SET`/`GET` round-trip under the
  compose password.
- **Web** — `pnpm dev` stack serves `http://127.0.0.1:3000/` (`<title>Buttery`),
  `/login` 200, and the atproto sign-in handshake returns an
  `oauth/authorize` URL. A live source edit (title string) was reflected in the
  served HTML, confirming the edit → serve loop.

## Still broken / needs a fix

### 1. The pinned toolchain is installed but is not the default on `PATH`

`mise install` succeeds, yet `node`/`pnpm` still resolve to the base image's
`/opt/node22` (Node **v22**), not the pinned **node@26.7.0**. Two independent
causes, both confirmed:

- **profile.d ordering.** The setup script writes `/etc/profile.d/mise.sh`, but
  `/etc/profile.d/nodejs.sh` (`export PATH=/opt/node22/bin:$PATH`) sorts _after_
  it alphabetically and re-prepends base Node ahead of the mise shims. So even a
  login shell gets Node 22. **Tested fix:** name the snippet so it sorts last —
  `/etc/profile.d/zzz-mise.sh` — and a `bash -lc 'node --version'` then reports
  `v26.7.0`.
- **Non-login / non-interactive shells never source `/etc/profile.d` at all.**
  This is the shell the agent's tools (and any `bash -c …`) actually run in.
  There the mise shims are absent from `PATH` _and_ the inherited `mise` shell
  function is broken — it references `$__MISE_EXE`, which isn't exported into
  these shells, so `mise <anything>` fails with `command not found`. Renaming the
  profile snippet does **not** help here (`bash -c 'node --version'` stays
  `v22`), because profile.d is skipped entirely.

**Fix — do both:**

1. **Primary (reaches the agent/tool shells):** because non-login shells never
   read profile.d, the only lever that fixes them is the environment's own
   `PATH`. The env `PATH` setting can't interpolate, so hardcode the shims dir at
   the **front**:

   ```
   /root/.local/share/mise/shims
   ```

   (In this cloud image `HOME=/root` and `MISE_DATA_DIR` is unset, so the shims
   live there; putting it ahead of `/opt/node22/bin` makes node@26/pnpm win in
   every shell, and using the real shim executables sidesteps the broken `mise`
   function entirely.)

2. **Secondary (human TUI / login + interactive shells):** in the setup script,
   name the profile snippet to sort last and also drop it into
   `/etc/bash.bashrc` (interactive non-login shells don't read profile.d either).
   See the drop-in script below.

### 2. `ghcr.io` returns intermittent `503 Service Unavailable`

Not a hard block (and not a proxy denial — nothing for ghcr in the proxy's
`recentRelayFailures`), but flaky: pulling
`ghcr.io/railwayapp-templates/postgres-ssl:18.4` failed with `503` on the
manifest/blob HEAD/GET on several attempts and only succeeded on retry. Docker
Hub (`redis`) pulled first try. **Fix idea:** have the setup script pre-pull the
two dev images with a retry/backoff loop so the first `pnpm dev` doesn't race a
flaky ghcr, or pre-bake them into the base image.

### 3. `better-auth` MCP server is unusable in cloud sessions

`.mcp.json` points `better-auth` at `https://mcp.better-auth.com/mcp`. The proxy
answers **403 on CONNECT** to `mcp.better-auth.com:443` (confirmed in
`recentRelayFailures`), and the server also requires an interactive OAuth flow
that a non-interactive cloud session can't complete. Net: this MCP server is
always unavailable here. **Fix idea:** allowlist `mcp.better-auth.com` if it's
meant to be reachable, and/or gate that entry out of the rendered `.mcp.json` for
cloud sessions so it doesn't show up as a broken server.

### 4. Web dev server crashes on x86 — `@resvg/resvg-js` native module (app fix)

Not a provisioning issue, but it fully blocks `pnpm dev`'s web process on this
**x86_64** cloud env (this repo is developed on ARM macOS, so it likely never
surfaces locally). Vite 8 / rolldown's **client** dependency optimizer tries to
scan the native `@resvg/resvg-js` binding and fails:

```
[UNLOADABLE_DEPENDENCY] Could not load …/@resvg/resvg-js-linux-x64-gnu/resvgjs.linux-x64-gnu.node
 - stream did not contain valid UTF-8 in …/@resvg/resvg-js/js-binding.js
```

The `.node` file itself is a valid ELF and present on disk — the optimizer just
shouldn't be bundling a native, server-only module. `resvg` is already a
server-only lazy `import("@resvg/resvg-js")` (OG-image rendering), so excluding
it from the client optimizer is correct and **arch-agnostic**:

```ts
// services/web/vite.config.ts
optimizeDeps: { exclude: ["@resvg/resvg-js"] },
```

**Verified:** with that line the web process boots and serves 200 on every arch
(the exclude is a no-op where the optimizer wasn't choking). Not applied on this
branch — this branch carries only FEEDBACK — but it's the one code change needed
for a working web server on x86. (`satori` is pure JS and doesn't need this.)

## Suggested cloud env setup script (drop-in replacement)

Generic — no repo-specific or custom-task commands, only default `mise` plus
system setup, so it works for any mise repo. Changes vs. the current script are
the two PATH fixes for login/interactive shells (item 1, secondary). The
**primary** PATH fix for the agent's non-login tool shells is the hardcoded
`PATH` env entry above — a setup script alone can't reach those shells.

```bash
#!/bin/bash
set -uo pipefail

apt update
apt install -y gh extrepo
extrepo enable mise
apt update
apt install -y mise

# Activate mise for future shells. Two changes vs. before:
#  * Sort AFTER the base image's PATH scripts (e.g. /etc/profile.d/nodejs.sh,
#    which re-prepends /opt/node22/bin) so the mise shims win — hence zzz-*.
#  * Also write /etc/bash.bashrc: interactive non-login shells read it but not
#    /etc/profile.d. (Non-interactive `bash -c` shells read neither — those are
#    covered by hardcoding the shims dir in the environment's PATH setting.)
MISE_ACTIVATE='export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"
command -v mise >/dev/null && eval "$(mise activate bash)"'
printf '%s\n' "$MISE_ACTIVATE" > /etc/profile.d/zzz-mise.sh
printf '\n%s\n' "$MISE_ACTIVATE" >> /etc/bash.bashrc
export PATH="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH"

if command -v docker >/dev/null && ! docker info >/dev/null 2>&1; then
  nohup dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || echo "WARN: dockerd did not come up (see /var/log/dockerd.log)"
fi

REPO_DIR=""
for c in "${CLAUDE_PROJECT_DIR:-}" "$PWD" "$HOME/workspace" ./workspace /home/user/* /workspace/*; do
  [ -n "$c" ] || continue
  if [ -f "$c/mise.toml" ] || [ -f "$c/.mise.toml" ]; then REPO_DIR="$c"; break; fi
done
if [ -z "$REPO_DIR" ]; then
  found="$(find /home /workspace -maxdepth 3 -name mise.toml 2>/dev/null | head -n1)"
  [ -n "$found" ] && REPO_DIR="$(dirname "$found")"
fi

if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR" ]; then
  echo "WARN: no mise.toml found; skipped trust/install"
  exit 0
fi

cd "$REPO_DIR"
mise trust
mise install --yes || echo "WARN: some tools failed to install (see above)"
```

### Proxy-blocked domains (candidates for the egress allowlist)

- `mcp.better-auth.com` — **confirmed 403 on CONNECT** (item 3). Only needed if
  the `better-auth` MCP server is meant to work in cloud sessions.
