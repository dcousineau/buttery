# Sandboxing coding agents

Rationale behind `.srt-settings.json.example`. For the commands, see the [README](../README.md#running-claude-code-sandboxed).

The `srt` binary comes from `mise install` — `mise.toml` lists `npm:@anthropic-ai/sandbox-runtime` alongside the rest of the toolchain, so it is on `PATH` in the repo without an `npx` round-trip per invocation.

## Why the sandbox runtime, and not a dev container

Claude Code's built-in `/sandbox` restricts Bash commands only — built-in file tools, MCP servers, and hooks still run unconstrained on the host. That is not enough for a session running unattended.

[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) wraps the whole process — tools, MCP servers, and hooks — in Seatbelt on macOS or bubblewrap on Linux. It is a lighter boundary than a container (shared kernel, shared network stack), but it leaves `railway dev` and the Claude in Chrome extension working unchanged, which a dev container does not.

A dev container is the stronger boundary and the better answer for a team. The cost for this repo is specific: the atproto OAuth flow bakes origins into `client_id` and redirect URIs, so the moment the browser lives in a different network namespace than the local PDS and the Vite dev server, those issuer URLs have to be rewritten to keep the handshake valid. Worth paying for reproducibility across machines; not worth paying to sandbox one laptop.

For genuinely untrusted code, neither is right — use a VM or [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).

## Why the settings file is untracked, and why it can still live in the repo

Upstream's warning is about _checked-out_ policy: _"Embedders should source security options only from trusted user-level configuration, never from checked-out project files."_ The concrete risk is that the runtime's mandatory deny list covers `.claude/`, `.mcp.json`, `.git/hooks`, and shell rc files — but not an arbitrary `.srt-settings.json`. A session that can write its own policy file widens its own sandbox on the next run.

Keeping the file in the repo is fine as long as that write is closed, which is why `.srt-settings.json` appears in its own `denyWrite` list. It is also gitignored, so it never arrives with a clone — only `.srt-settings.json.example` is tracked, matching how this repo handles `.mcp.json`. Copy the example, edit locally, and leave the `denyWrite` entry in place.

## Why `--settings` rather than the default path

The runtime starts anyway when the default `~/.srt-settings.json` is missing or malformed, silently falling back to no-network and a handful of built-in write paths. A clean launch is therefore not evidence that your config loaded. Passing `--settings <file>` explicitly makes it refuse to start on a load failure — you get a validation error naming the bad keys instead of a session that silently can't reach the network.

## Required keys

`network.deniedDomains` and `filesystem.denyRead` are **required**, not optional, even when empty. Omitting them fails validation:

```txt
Invalid configuration in ./.srt-settings.json:
  - network.deniedDomains: Required
  - filesystem.denyRead: Required
```

To check a config without starting a session, wrap a no-op: `srt --settings ./.srt-settings.json /usr/bin/true`. Exit 0 means it validates.

## Print mode only — the TUI cannot run sandboxed

Seatbelt denies terminal `ioctl`s to the sandboxed process, so anything that wants raw mode fails:

```txt
$ srt --settings ./.srt-settings.json -c 'stty raw'
stty: TIOCGETD: Operation not permitted
```

Claude Code's TUI is built on Ink, which calls `setRawMode` on stdin. Denied, it falls back to line-buffered input: keystrokes queue until Enter, vim-mode bindings do nothing, and redraw escape sequences interleave with the cooked-mode echo. The symptom reads as a character-encoding bug, but the environment is clean — `LANG`, `TERM`, `TERMINFO_DIRS`, and `COLORTERM` all pass through the sandbox unchanged.

No settings key reaches it. Seatbelt treats `file-ioctl` as an operation distinct from `file-write*`, so adding `/dev/tty`, `/dev/ttys*`, or `/dev/ptmx` to `allowWrite` changes nothing.

Upstream has a `--tty` passthrough PR, but it is not in any published release — `srt --help` on the installed build lists only `-V`, `-d`, `-s`, `-c`, and `--control-fd`.

So run sandboxed sessions in print mode, which needs no raw mode:

```bash
srt --settings ./.srt-settings.json claude -p "<task>" --dangerously-skip-permissions
```

That is the intended shape anyway — the sandbox exists for unattended runs. For interactive work, either drop to Claude Code's built-in `/sandbox` (Bash-only, so file tools, MCP servers, and hooks stay unconstrained) or use a container or VM. Track the `--tty` release if you want the interactive TUI inside `srt` unchanged.

## Write grants

Narrow by default. Each entry earns its place:

| Path                   | Why                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `.`                    | The repo. Relative to cwd — swap for an absolute path if you launch from elsewhere.                 |
| `/tmp`                 | Claude Code runtime files — on macOS this entry alone does nothing; see below.                      |
| `/private/tmp`         | What `/tmp` actually resolves to on macOS. **This** is the entry that works.                        |
| `~/.npm`               | `npx` cache — MCP servers (chrome-devtools-mcp and friends) are fetched this way.                   |
| `~/Library/pnpm/store` | pnpm's content-addressed store (`pnpm store path`). Needed only if the agent installs dependencies. |
| `~/.claude`            | Session history, todos, shell snapshots. Claude Code does not run without it.                       |

`~/.npm` and the pnpm store exist only so a session can run `pnpm install`. Run installs yourself before handing off and both can be dropped.

### `/tmp` does not grant `/tmp` on macOS

`/tmp` is a symlink to `/private/tmp`. Seatbelt matches on the path the kernel resolves at syscall time, not the literal you wrote, so a rule written as `/tmp` never matches anything. The failure is not subtle in effect but is very confusing in appearance: **the Bash tool cannot start at all**, because its own scratch directory bootstrap is denied before any user command runs.

```txt
EPERM: operation not permitted, mkdir '/private/tmp/claude-501/<cwd-slug>/<session-id>'
```

Read, Write, and Edit keep working the whole time — they never need that directory — so the session looks healthy right up until every single Bash call fails identically, including `pwd`, including `dangerouslyDisableSandbox: true`, and including calls from freshly spawned subagents (they share the sandbox). A session that hits this cannot fix itself: the policy is applied at process launch, so editing the settings file mid-run changes nothing.

Verified by swapping one entry at a time, everything else held constant:

```txt
allowWrite entry     mkdir /tmp/probe
"/tmp"               DENIED
"/tmp/**"            DENIED
"/private/tmp"       OK
"/private/tmp/**"    OK
```

Both are kept: `/private/tmp` is the one doing the work on macOS, and `/tmp` is a real directory on Linux, where `/private/tmp` does not exist.

## Unix sockets, and Claude in Chrome

Unix sockets are **blocked by default** on every platform. On macOS `network.allowUnixSockets` is an allowlist of paths.

This is what makes the browser tools disappear. Claude Code talks to the Chrome extension over a unix socket at `/private/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` (the extension side is a native messaging host registered at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`). With the socket blocked, the bridge never connects and no `mcp__claude-in-chrome__*` tool is registered — a `ToolSearch` for browser tooling returns nothing, which reads like a missing extension rather than a sandbox denial.

Two properties of the allowlist matter, both verified:

- **No glob support.** Only literal paths, unlike `filesystem`. `/private/tmp/claude-mcp-browser-bridge-*/*.sock` and `/private/tmp/claude-mcp-browser-bridge-*` are both denied.
- **A directory entry covers its sockets.** Which is the way out, because the filename is a pid and changes every session.

So the entry names the bridge directory, not the socket. It contains a username, so **edit it after copying the example** — a wrong username fails silently, with the browser tools simply absent again. And `/tmp/claude-mcp-browser-bridge-...` does not work here either, for the resolution reason above.

The narrower alternative — pinning the exact `<pid>.sock` — works but has to be rewritten every session. The broader one — allowing `/private/tmp` wholesale — also works and hands the session every other IPC socket on the machine.

Deliberately absent: `~/.local/share/mise` and `~/.cache`. Those are written by `mise install`, which installs a toolchain that `mise.toml` already pins. An agent session has no reason to touch them.

## Why `~/.claude` is also denied in part

`~/.claude` has to be writable, but it is also where Claude Code loads user-level configuration from. A session that can write `~/.claude/settings.json` or `~/.claude/hooks/` installs code that runs **unsandboxed** on the next launch — exactly the persistence the mandatory deny list exists to prevent, except that list scopes `.claude/` to the _project_ root, not your home directory.

So the example denies `settings.json`, `hooks/`, `agents/`, `commands/`, `skills/`, and `plugins/` inside `~/.claude`. Claude Code's own guidance says to do this: _"Your write grants still include other paths Claude Code loads configuration from, so deny those with `denyWrite`."_

One gap remains. `~/.claude.json` stays writable because Claude Code needs it for project trust and account state, and it also holds user-scoped MCP server definitions. Deny it if that matters to you, and accept re-approving trust every run.

## Read grants

`denyRead` is required but empty by default, which means **full read access to the entire filesystem**. Write grants alone do not stop a session from reading credentials; combined with any allowed egress domain, that is an exfiltration path.

The example denies `~/.ssh`, `~/.aws`, `~/.gnupg`, and `~/Library/Keychains`. It deliberately leaves two credential stores readable, because the workflow needs them:

- `~/.railway` — `railway run` reads `~/.railway/config.json` to authenticate, and that file holds a plaintext access and refresh token. Denying it means passing `RAILWAY_TOKEN` through the environment instead.
- `~/.config/gh` — `gh` needs it. Denying it means no GitHub CLI in-session.

**Consequence of denying `~/.ssh`:** this repo's `origin` is an SSH remote (`git@github.com:dcousineau/buttery.git`), so nothing that talks to `origin` works inside the sandbox — not just `git push` but `git fetch` too. `deniedDomains` also blocks port 22 outright, reinforcing that. Treating push as a human step is a reasonable default for unattended sessions anyway, but a session that needs to _read_ another branch is not stuck: git over HTTPS works, verified in-sandbox.

```bash
git ls-remote https://github.com/dcousineau/buttery.git <branch>
git fetch https://github.com/dcousineau/buttery.git <branch>:<local-branch>
```

**`gh` does not work, and no allowlist entry fixes it.** `gh` is a Go binary, and Go verifies TLS on macOS through `com.apple.trustd.agent`, a mach service Seatbelt blocks. Reaching the host is not the problem — `curl https://api.github.com/` returns 200 from the same sandbox — so this fails _after_ the domain allowlist has already said yes:

```txt
Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: OSStatus -26276
```

`SSL_CERT_FILE` does not help; Go on darwin goes to the Security framework regardless. The only switch that fixes it is `enableWeakerNetworkIsolation: true`, which re-opens `trustd` and which upstream explicitly flags as an exfiltration vector. It is deliberately **not** set here — use the HTTPS git commands above, or `curl` the API, both of which work unchanged. The same limitation applies to any other Go CLI (`gcloud`, `terraform`, `kubectl`).

## Authenticating without opening the Keychain

On macOS, Claude Code keeps its OAuth credentials in a login-keychain item named `Claude Code-credentials` (there is no `~/.claude/.credentials.json` — that path is the Linux store). `~/Library/Keychains` is denied, so a sandboxed session cannot read it and prompts you to log in on every launch. The deny is doing its job; the fix is to hand the session a credential rather than to lift it.

Mint a long-lived token once, outside the sandbox — it opens a browser, so it cannot run sandboxed anyway:

```bash
claude setup-token
```

Export the result as `CLAUDE_CODE_OAUTH_TOKEN` from your shell profile. `srt` passes the environment through to the sandboxed process unchanged (verified with a sentinel variable), so nothing in `.srt-settings.json` needs to change. Keep it out of the repo — it is a credential, and this file is tracked.

**Do not remove `~/Library/Keychains` from `denyRead` instead.** It reads like a one-line fix and it does work, but the login keychain is a single database file, so there is no way to expose only the Claude item. With that deny lifted, `security find-generic-password -s <anything> -w` returns secrets in the clear — Wi-Fi, browser-saved passwords, every app token — to a session that also has allowed egress domains. Verified in both directions:

```txt
denyRead as shipped            → security find-generic-password … → DENIED
denyRead minus ~/Library/…     → security find-generic-password … → OK, secret printed
```

The token narrows that blast radius to one revocable credential. It does not eliminate it: the token is in the sandboxed process's environment by construction, so a compromised session can still exfiltrate that token. Revoke it from your account settings if a run goes wrong.

An `ANTHROPIC_API_KEY` works the same way and keeps the Keychain denied, but bills to API credits rather than the subscription.

## Network grants

`allowedDomains` is empty by default, meaning no network at all. The example opens:

- **Anthropic** — `api.anthropic.com`, `claude.ai`, `platform.claude.com`. The last two are needed for OAuth sign-in and token refresh; API-key sessions can drop them.
- **Toolchain** — `registry.npmjs.org`, `github.com`, `api.github.com`, `*.githubusercontent.com`. `github.com` does **not** cover `api.github.com`; only `*.github.com` would, and that is broader than needed.
- **Local services** — `localhost`, `127.0.0.1`, `*.railway.localhost` for `railway dev`'s Postgres, Redis, and Caddy proxy.
- **Railway** — `backboard.railway.com` for the CLI, `*.railway.app` for blob storage.
- **atproto** — `plc.directory`, `*.bsky.network` (the relay), `*.bsky.app`.
- **PostHog** — `us.i.posthog.com`, `us.posthog.com`, `event.buttery.recipes`.
- **MCP** — `mcp.better-auth.com`, the one remote server in `.mcp.json.example`.

`statsig.anthropic.com` and `sentry.io` are telemetry, not function. Drop them and set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` if you prefer; the cost is that server-side feature flags stop evaluating.

`deniedDomains` is `["*:22"]` — checked before `allowedDomains`, so it blocks SSH egress even though `github.com` is allowed on all ports. See the read-grants section for what that costs.

`allowLocalBinding` defaults to `false` and the example turns it on. Without it the Vite dev server and the atproto dev-env cannot bind their ports.

### Reaching the local dev stack from inside the sandbox

An `allowedDomains` entry with no `:port` suffix matches **every** port on that host, so the bare `localhost` / `127.0.0.1` entries already cover the whole stack. Nothing needs adding per service, and adding `localhost:2583` next to `localhost` would imply a narrowing that is not real. Verified reachable under `srt --settings ./.srt-settings.json`, all `200`:

| Service                | URL                                   |
| ---------------------- | ------------------------------------- |
| Web (TanStack Start)   | `http://127.0.0.1:3000/`              |
| atproto PDS / OAuth AS | `http://localhost:2583/xrpc/_health`  |
| atproto PLC (DID docs) | `http://localhost:2582/_health`       |
| process-compose API    | `http://localhost:8099/live`          |
| Postgres / Redis       | via `*.railway.localhost` (see above) |

IPv6 loopback (`http://[::1]:2583`) and Node's `fetch` both work too — `localhost` matching is not IPv4-only, so nothing needs an explicit `::1` entry.

Two things this does **not** buy you: `curl` from the _agent's own_ Bash tool is a separate sandbox with its own rules, and a `000` from there is not evidence about `srt`; and the ports only answer when the stack is actually up (`process-compose project state`).

## After an unattended run

Review what stayed writable — the repo diff, and on Linux anything the session created after launch. The Linux backend builds its deny list once at startup: it covers the project root reliably and makes a best-effort shallow scan for nested repos, but does not cover directories created mid-session by `git init`, `git clone`, or scaffolding. macOS checks denies at write time, so nested paths are covered there.
