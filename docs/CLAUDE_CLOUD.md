# Cloud sessions (Claude Code on the web)

Checks and fixes for a session running in the cloud container. Irrelevant to
local dev.

## Toolchain

`node --version` must report v26 in a plain tool shell. If it reports v22, the
setup script did not finish — fix it, don't work around it:

```bash
ln -sf "$HOME/.local/share/mise/shims"/* "$HOME/.local/bin/"
```

Stopgap until then: wrap commands in `bash -lc '…'`, including `git commit`
(the husky hook runs pnpm).

## Browser HTTPS

External `https://` page loads through the Playwright MCP fail
`ERR_CERT_AUTHORITY_INVALID` unless the agent proxy's CA is in Chromium's own
trust store (loopback pages work either way, so this hides easily):

```bash
apt install -y libnss3-tools
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n ccr-agent-proxy \
  -i /root/.ccr/agent-proxy-ca.crt
```

## Playwright MCP browser

`scripts/dev/render-mcp.mjs` pins the server to `/opt/pw-browsers/chromium`. If
that binary is missing:

```bash
mise exec -- npx --yes playwright@latest install-deps chromium
mise exec -- npx --yes @playwright/mcp@latest install-browser chromium
```

Never `playwright install chromium` — it fetches a revision the MCP refuses to
launch.

## Egress

Reachable and needed: `*.npmjs.org`, `ghcr.io`, Docker Hub,
`*.better-auth.com`, `cdn.playwright.dev` + `*.azureedge.net`. Anything else
that fails: report the blocked host, don't route around it.

## Running and checking the stack

`pnpm install`, then `process-compose up --detached` (`pnpm dev` blocks). Ready
means `postgres`, `redis`, `web`, `atproto-dev-env` running and
`dev-containers`, `migrate` completed. See the `local-dev` skill to drive it.

| Check                     | Command                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web serves                | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/` — also `/login`                                                                                                  |
| atproto sign-in handshake | POST `{"handle":"chef.test"}` to `/api/auth/atproto/sign-in` → an `oauth/authorize` URL                                                                                          |
| tests, types, lint        | `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                                                                                                  |
| DB-backed tests           | `pnpm --filter @buttery/web exec vitest run --project db` with `DATABASE_URL` from `services/web/.env` — **not** `pnpm test:db`, which wraps `railway run` and has no login here |

## Environment setup script (humans only — do not run this)

> **Agents: this is a reference, not a task.** It is what the container already
> ran before the session started. Never execute it, and never re-run pieces of
> it to "repair" a session — the targeted fixes above are the supported repair
> path. This section exists so a human can paste it into the setup-script field
> when spinning up a new cloud environment.

```bash
#!/bin/bash
set -uo pipefail

apt update
apt install -y gh extrepo libnss3-tools
extrepo enable mise
apt update
apt install -y mise

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

SHIMS="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"
if [ -d "$SHIMS" ]; then
  mkdir -p "$HOME/.local/bin"
  for shim in "$SHIMS"/*; do
    [ -x "$shim" ] || continue
    ln -sf "$shim" "$HOME/.local/bin/$(basename "$shim")"
  done
fi
```
