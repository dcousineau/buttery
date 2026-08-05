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
| `/tmp`                 | Claude Code runtime files.                                                                          |
| `~/.npm`               | `npx` cache — MCP servers (chrome-devtools-mcp and friends) are fetched this way.                   |
| `~/Library/pnpm/store` | pnpm's content-addressed store (`pnpm store path`). Needed only if the agent installs dependencies. |
| `~/.claude`            | Session history, todos, shell snapshots. Claude Code does not run without it.                       |

`~/.npm` and the pnpm store exist only so a session can run `pnpm install`. Run installs yourself before handing off and both can be dropped.

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

**Consequence of denying `~/.ssh`:** this repo's `origin` is an SSH remote (`git@github.com:dcousineau/buttery.git`), so `git push` does not work inside the sandbox. `deniedDomains` also blocks port 22 outright, reinforcing that. Push from outside the sandbox, or use `gh` over HTTPS. Treating push as a human step is a reasonable default for unattended sessions anyway.

## Network grants

`allowedDomains` is empty by default, meaning no network at all. The example opens:

- **Anthropic** — `api.anthropic.com`, `claude.ai`, `platform.claude.com`. The last two are needed for OAuth sign-in and token refresh; API-key sessions can drop them.
- **Toolchain** — `registry.npmjs.org`, `github.com`, `*.githubusercontent.com`.
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
