# Sandboxing coding agents

Rationale behind `.srt-settings.json.example`. For the commands, see the [README](../README.md#running-claude-code-sandboxed).

## Why the sandbox runtime, and not a dev container

Claude Code's built-in `/sandbox` restricts Bash commands only — built-in file tools, MCP servers, and hooks still run unconstrained on the host. That is not enough for a session running unattended.

[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) wraps the whole process — tools, MCP servers, and hooks — in Seatbelt on macOS or bubblewrap on Linux. It is a lighter boundary than a container (shared kernel, shared network stack), but it leaves `railway dev` and the Claude in Chrome extension working unchanged, which a dev container does not.

A dev container is the stronger boundary and the better answer for a team. The cost for this repo is specific: the atproto OAuth flow bakes origins into `client_id` and redirect URIs, so the moment the browser lives in a different network namespace than the local PDS and the Vite dev server, those issuer URLs have to be rewritten to keep the handshake valid. Worth paying for reproducibility across machines; not worth paying to sandbox one laptop.

For genuinely untrusted code, neither is right — use a VM or [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).

## Why the settings file is not committed

Upstream does not support project-local settings, deliberately: _"Embedders should source security options only from trusted user-level configuration, never from checked-out project files."_

The reason is concrete. The runtime's mandatory deny list covers `.claude/`, `.mcp.json`, `.git/hooks`, and shell rc files — but not an arbitrary `.srt-settings.json` sitting in the repo. A sandboxed session that could write its own policy file would widen its own sandbox on the next run. So `.srt-settings.json` is gitignored and only the `.example` is tracked, matching how this repo already handles `.mcp.json`.

## Why `--settings` rather than the default path

The runtime starts anyway when the default `~/.srt-settings.json` is missing or malformed, silently falling back to no-network and a handful of built-in write paths. A clean launch is therefore not evidence that your config loaded. Passing `--settings <file>` explicitly makes it refuse to start on a load failure.

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

`allowLocalBinding` defaults to `false` and the example turns it on. Without it the Vite dev server and the atproto dev-env cannot bind their ports.

## After an unattended run

Review what stayed writable — the repo diff, and on Linux anything the session created after launch. The Linux backend builds its deny list once at startup: it covers the project root reliably and makes a best-effort shallow scan for nested repos, but does not cover directories created mid-session by `git init`, `git clone`, or scaffolding. macOS checks denies at write time, so nested paths are covered there.
