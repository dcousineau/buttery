# Local dev / cloud environment feedback

Running notes from working this branch in a Claude Code **cloud** session. Kept
succinct; each item is a friction point plus a concrete fix suggestion.

## Verified working this session

Full end-to-end check on this branch (x86_64 cloud session). Tools were resolved
through the mise shims (see item 1 for why that prefix is still needed):

- **Toolchain + containers.** `mise install` brings up node@26.7.0, pnpm@11.20.0,
  process-compose, and railway. Docker daemon is up at session start and `gh` is
  preinstalled. Both registries pull cleanly — `redis:8.2.1` (Docker Hub) and
  `ghcr.io/railwayapp-templates/postgres-ssl:18.4` (ghcr) — and the
  docker-compose stack boots healthy. _(The earlier CloudFront 403 and flaky
  ghcr 503 did not recur; dropped as transient.)_
- **`.env`-driven boot.** The postinstall hook's `setup:env` + `setup:mcp` render
  `services/web/.env` (with a generated `BETTER_AUTH_SECRET`) and `.mcp.json`
  (with the dev `DATABASE_URL` baked in). No `railway run` needed.
- **Postgres** — reachable on `55432`, PostgreSQL **18.4**, all migrations
  applied (34 tables present).
- **Redis** — reachable on `56379`, `PING`/`SET`/`GET` round-trip under the
  compose password.
- **Web** — the process-compose stack serves `http://127.0.0.1:3000/` (`200`,
  `<title>Buttery`), `/login` `200`, and the atproto sign-in handshake returns an
  `oauth/authorize` URL. A live title edit was reflected in the served HTML and
  then reverted — the edit → serve loop is confirmed.
- **`@resvg/resvg-js` on x86 (was a blocker).** `optimizeDeps: { exclude:
["@resvg/resvg-js"] }` in `services/web/vite.config.ts` is applied; the web
  process boots and serves `200` on x86_64. `resvg` stays a server-only lazy
  `import()`, so the exclude is arch-agnostic (a no-op where the optimizer wasn't
  choking). **Resolved.**
- **Login-shell PATH (was the "secondary" half of item 1).** A login shell now
  reports `node v26.7.0` and has `process-compose` on `PATH`
  (`/etc/profile.d/zzz-mise.sh` is in place and sorts after the base image's
  `nodejs.sh`). **Resolved for login/interactive shells** — see item 1 for the
  non-login shells that still miss it.
- **Playwright MCP drives the app.** After the config fix below, the `playwright`
  MCP server loads the app in headless Chromium: navigated
  `http://127.0.0.1:3000/`, got a full accessibility snapshot **and** a rendered
  screenshot, page title `Buttery`. It uses the base image's **pre-baked**
  Chromium (`/opt/pw-browsers/chromium`) with no mid-session download.

## Still needs an env / provisioning change

### 1. Pinned toolchain is not on `PATH` for the agent's (non-login) tool shells

The login/interactive-shell fix landed (see above), but the shell the agent's
tools actually run in — a **non-login** `bash -c …` — still gets it wrong.
Confirmed this session:

- In a tool shell, `node` resolves to `/opt/node22/bin/node` (**v22**), and
  `process-compose` / `railway` are **not found** (they live only in the mise
  shims dir, which isn't on this `PATH`).
- The inherited `mise` **shell function** is broken here: it references
  `$__MISE_EXE`, which is unset in these shells, so `mise <anything>` fails with
  `command not found`. (The `/usr/bin/mise` binary exists but the function
  shadows it.)
- Non-login shells never source `/etc/profile.d`, so `zzz-mise.sh` — which fixes
  login shells — cannot reach them.

**Fix (environment `PATH` setting, not the setup script).** The only lever that
reaches non-login shells is the environment's own `PATH`. It can't interpolate,
so hardcode the shims dir at the **front**:

```
/root/.local/share/mise/shims
```

(In this image `HOME=/root` and `MISE_DATA_DIR` is unset, so the shims live
there. Putting it ahead of `/opt/node22/bin` makes node@26 / pnpm win in every
shell, and calling the real shim executables sidesteps the broken `mise`
function entirely.) Until this is set, everything above works only when a command
prepends the shims dir by hand.

### 2. `better-auth` MCP server is unusable in cloud sessions

`.mcp.json` points `better-auth` at `https://mcp.better-auth.com/mcp`. The proxy
answers **403 on CONNECT** to `mcp.better-auth.com:443`, and the server also
requires an interactive OAuth flow a non-interactive cloud session can't
complete. Net: this server is always unavailable here. **Fix idea:** allowlist
`mcp.better-auth.com` (the allowlist's bare `better-auth.com` doesn't cover the
subdomain — `*.better-auth.com` does) if it's meant to be reachable, and/or gate
this entry out of the rendered `.mcp.json` for cloud sessions so it doesn't show
up as a broken server.

## Playwright MCP — fixes applied on this branch

The `playwright` MCP server failed on first use with `Chromium distribution
'chrome' is not found at /opt/google/chrome/chrome`. Two problems, both fixed in
this branch so a fresh cloud session works without provisioning a browser:

1. **Wrong browser channel.** `@playwright/mcp` defaults to the branded **chrome**
   channel, which the image doesn't ship. Added `--browser chromium` to the
   `playwright` server args in **`.mcp.json.example`** so it uses Chromium.
2. **Version drift vs. the pre-baked browser.** `@playwright/mcp@latest` bundles a
   `playwright-core` that wants a _newer_ Chromium build than the one the base
   image pre-bakes (`/opt/pw-browsers/chromium` → build `1194` this session), so a
   bare `--browser chromium` would download a second copy mid-session. Instead,
   **`scripts/dev/render-mcp.mjs`** now injects `--executable-path
/opt/pw-browsers/chromium` into the rendered `.mcp.json` **only when that
   pre-baked binary exists** (guarded by `PLAYWRIGHT_BROWSERS_PATH` /
   `/opt/pw-browsers`, so it's a no-op on macOS dev). Verified: the latest
   `playwright-core` drives the older pre-baked Chromium over CDP fine, so this is
   version-independent and needs **no download and no browser-CDN egress**.

Also added `.playwright-mcp` to `.gitignore` (the MCP writes snapshots /
screenshots / traces there).

`--headless` is required (no display in a cloud session) and `--isolated` keeps
the server off any persistent browser profile — both already present.

## Suggested cloud env setup script (drop-in replacement)

The script **currently set** in the environment already lands the login-shell
PATH fix (`/etc/profile.d/zzz-mise.sh` + `/etc/bash.bashrc`) — confirmed working
this session. The only change vs. that script is to **drop the Playwright browser
install**: the base image already ships Chromium _and_ its system libs (the
pre-baked browser launched and rendered a screenshot this session), and the MCP
is now pinned to that binary (above), so `playwright install --with-deps
chromium` is redundant. If a future base image ever stops pre-baking the browser,
the render's guard falls back to a bare `--browser chromium` (which then needs the
Playwright CDN in the allowlist — see below).

The **primary** PATH fix for the agent's non-login tool shells (item 1) is the
hardcoded `PATH` env entry, which a setup script can't provide.

```bash
#!/bin/bash
set -uo pipefail

apt update
apt install -y gh extrepo
extrepo enable mise
apt update
apt install -y mise

# Activate mise for future shells:
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

# NOTE: no `playwright install` here. The base image pre-bakes Chromium + its
# system libs under $PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers), and the
# Playwright MCP is pinned to that binary by scripts/dev/render-mcp.mjs, so there
# is nothing to download. Re-add `mise exec -- npx --yes playwright@latest install
# --with-deps chromium` only if a future base image stops pre-baking the browser.
```

### Proxy-blocked domains (candidates for the egress allowlist)

- `registry.npmjs.org` / `*.npmjs.org` — **still required.** The Playwright MCP is
  launched as `npx --yes @playwright/mcp@latest`, which fetches the MCP package
  from npm on first use in a fresh container. (The browser itself no longer needs
  egress — it's pre-baked.)
- `cdn.playwright.dev` and `*.azureedge.net` — **fallback only now.** Needed for a
  Playwright _browser_ download, which the pinned pre-baked Chromium avoids;
  keep them allowlisted only as a safety net if the pre-bake ever goes away.
- `fonts.googleapis.com` / `fonts.gstatic.com` — **new, optional.** The app's home
  page requests Google Fonts (Alfa Slab One, Rubik); the fetch is reset by the
  proxy (`ERR_CONNECTION_RESET` in the browser console) and the page falls back to
  system fonts. Cosmetic only — allowlist these if pixel-accurate rendering /
  screenshots matter, otherwise safe to leave blocked.
- `mcp.better-auth.com` — only if the `better-auth` MCP server is meant to work in
  cloud sessions (item 2). The allowlist has bare `better-auth.com`, which doesn't
  cover the subdomain; `*.better-auth.com` does.
