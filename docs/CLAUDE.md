# Cloud sessions (Claude Code on the web)

Everything here is about running this repo inside a **Claude Code cloud
session** — an ephemeral container, cloned fresh, with outbound HTTPS forced
through the agent proxy. Local dev on a laptop needs none of it; see the
[README](../README.md) and [docs/LOCAL-DEV.md](./LOCAL-DEV.md) for that.

The repo-side pieces are already committed: `optimizeDeps.exclude` for the
native resvg binding ([`services/web/vite.config.ts`](../services/web/vite.config.ts)),
and the Playwright MCP's browser wiring
([`.mcp.json.example`](../.mcp.json.example) +
[`scripts/dev/render-mcp.mjs`](../scripts/dev/render-mcp.mjs)). What remains
lives in the environment console: a **`PATH`** entry, the **setup script**, and
the **domain allowlist**.

## 1. `PATH` must start with the mise shims

**This is the one thing that still hard-blocks a session.** The base image ships
Node 22 at `/opt/node22/bin`; `package.json` declares `devEngines.runtime` `^26`
with `onFail: error`, so under the base image's Node every `pnpm install` dies:

```
[ERROR] This project requires Node.js ^26. Your current Node.js is v22.22.2
```

The setup script's `/etc/profile.d/zzz-mise.sh` + `/etc/bash.bashrc` fix login
and interactive shells — verified, a login shell reports `v26.7.0`. But the
shell the agent's tools actually run in is **non-login and non-interactive**
(`bash -c …`), and it reads neither file. There:

- `node` resolves to `/opt/node22/bin/node` (v22), and `process-compose` /
  `railway` aren't found at all — they exist only in the shims dir.
- The inherited `mise` **shell function** is broken: it references
  `$__MISE_EXE`, unset in these shells, so `mise <anything>` fails with
  `command not found` even though `/usr/bin/mise` exists.

The only lever that reaches those shells is the environment's own `PATH`. It
can't interpolate, so hardcode the shims directory at the **front**:

```
/root/.local/share/mise/shims
```

In this image `HOME=/root` and `MISE_DATA_DIR` is unset, so that's where mise
puts them. Ahead of `/opt/node22/bin` it makes node@26 and pnpm@11 win in every
shell, and calling the real shim executables sidesteps the broken `mise`
function. Until it's set, every command in a cloud session has to be wrapped in
`bash -lc '…'` — including `git commit`, which runs lint-staged through the
husky hook and fails the same way.

## 2. Setup script

Generic — default `mise` plus system setup, no repo-specific commands, so it
works for any mise repo. The one change from the script currently set in the
environment is the browser trust store block.

```bash
#!/bin/bash
set -uo pipefail

apt update
# libnss3-tools provides certutil, for the browser trust store below.
apt install -y gh extrepo libnss3-tools
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

# Chromium keeps its own trust store and does not read SSL_CERT_FILE, so the
# agent proxy's CA has to be imported into the NSS db by hand. Without this
# every https:// page load in the Playwright MCP fails ERR_CERT_AUTHORITY_INVALID
# (loopback pages are unaffected, which is why it hides easily).
if [ -f /root/.ccr/agent-proxy-ca.crt ] && command -v certutil >/dev/null; then
  mkdir -p "$HOME/.pki/nssdb"
  certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null
  certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n ccr-agent-proxy \
    -i /root/.ccr/agent-proxy-ca.crt \
    || echo "WARN: could not add the agent-proxy CA to the NSS store"
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

# NOTE: no `playwright install` here. The base image pre-bakes Chromium and its
# system libs under $PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers), and
# scripts/dev/render-mcp.mjs pins the MCP to that binary — nothing to download.
# If a future image stops pre-baking it, add
#   mise exec -- npx --yes playwright@latest install-deps chromium
#   mise exec -- npx --yes @playwright/mcp@latest install-browser chromium
# and note the second line must go through @playwright/mcp, NOT `playwright
# install` — the MCP tracks a prerelease playwright, so the stable CLI installs
# a Chromium revision the server then refuses to launch.
```

## 3. Domain allowlist

### Blocked in the browser

Captured by loading `/` and `/login` through the Playwright MCP and dumping the
network log for non-loopback hosts. The Google Fonts pair is the **only**
off-box request the app makes from the browser:

- **`fonts.googleapis.com`** — `services/web/src/styles.css` (and the docs
  site's `custom.css`) `@import`s the Alfa Slab One + Rubik stylesheet. In the
  browser that request is reset (`net::ERR_CONNECTION_RESET`) — the one failed
  request on both pages. The proxy logs no policy denial for it, and the same
  URL fetches 200 from `curl`, so the failure is browser-path-specific.
- **`fonts.gstatic.com`** — needed alongside it. The stylesheet resolves its
  `src: url(…)` woff2 files there. It never surfaces as a _failed_ request only
  because the CSS is reset before the browser can parse it; unblocking one
  without the other still leaves the fonts unloaded.

Impact is **cosmetic**: the page falls back to system faces and otherwise
renders and works. Allowlist the pair if screenshots need to be pixel-accurate.
Nothing server-side depends on the CDN — the OG card renderer vendors both
families as bytes (`services/web/src/server/og/fonts/`, deliberately, because
Satori can't read woff2), so OG images rasterize with correct type either way.

### Blocked during provisioning / MCP startup

| Host                                    | Needed by                                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry.npmjs.org` / `*.npmjs.org`    | still required — the MCP is launched as `npx --yes @playwright/mcp@latest`, fetched from npm on first use in a fresh container                                                                       |
| `cdn.playwright.dev`, `*.azureedge.net` | fallback only — the pinned pre-baked Chromium needs no download; keep them as a safety net if the pre-bake goes away                                                                                 |
| `*.better-auth.com`                     | **now reachable** — `mcp.better-auth.com` answers and the MCP server connects, so the earlier 403 on CONNECT is resolved. The bare `better-auth.com` does not cover the subdomain; keep the wildcard |
| `ghcr.io`, Docker Hub                   | the two docker-compose images. Both pulled clean this session; the earlier CloudFront 403 and ghcr 503 did not recur                                                                                 |

## 4. How the Playwright MCP is wired (committed, no action needed)

It failed on first use with `Chromium distribution 'chrome' is not found at
/opt/google/chrome/chrome`. Two problems, both fixed in the repo:

1. **Wrong browser channel.** `@playwright/mcp` defaults to the branded
   **chrome** channel, which the image doesn't ship. `.mcp.json.example` now
   passes `--browser chromium`.
2. **Version drift vs. the pre-baked browser.** `@playwright/mcp@latest` bundles
   a prerelease `playwright-core` that wants a newer Chromium than the image
   pre-bakes, so a bare `--browser chromium` fails (`Browser
"chrome-for-testing" is not installed`) or downloads a second copy
   mid-session. `render-mcp.mjs` instead injects `--executable-path
/opt/pw-browsers/chromium` when that binary exists — a no-op on macOS dev.

Re-verified this session against `@playwright/mcp` 0.0.79 / playwright
1.63.0-alpha: the server drives the pre-baked build (Chrome 141, from
`/opt/pw-browsers/chromium-1194`) over CDP with no download, loads the app, and
returns snapshots and screenshots. Newer playwright-core driving an older
Chromium holds up.

`--headless` is required (no display) and `--isolated` keeps the server off any
persistent profile. Its snapshot/screenshot output lands in `.playwright-mcp/`,
which is gitignored.

## 5. Verifying a session

```bash
pnpm install                       # fails fast if PATH is wrong (section 1)
pnpm dev                           # or: process-compose up --detached
```

`process-compose process list` should then show `postgres`, `redis`, `web` and
`atproto-dev-env` running/ready, with `dev-containers` and `migrate` completed.
Checks worth running once:

| Check                            | Command                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web serves                       | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` — also `/login`                                                                                                                          |
| atproto sign-in handshake        | POST `{"handle":"chef.test"}` to `/api/auth/atproto/sign-in` → an `oauth/authorize` URL                                                                                                                  |
| unit tests (incl. the OG raster) | `pnpm test` — the raster test is what proves the resvg native binding works on x86                                                                                                                       |
| DB-backed tests                  | `pnpm --filter @buttery/web exec vitest run --project db`, with `DATABASE_URL` taken from `services/web/.env`. The packaged `test:db` script wraps `railway run`, which a cloud session has no login for |
| types / lint / format            | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                                                                                                                       |

Last full pass: stack healthy, web + `/login` 200 with a working sign-in
handshake, 351 unit tests and 126 DB tests green, typecheck/lint/format clean.
