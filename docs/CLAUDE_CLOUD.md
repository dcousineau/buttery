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
