#!/usr/bin/env node
/* global process, console */
// ^ Plain JS run directly by Node (not part of the bundled app), so the Node
// globals have to be declared for the linter. Same reason as render-mcp.mjs.
//
// Regenerates the gitignored config files this repo renders from committed
// templates, after backing up whatever is there now.
//
// The problem it solves: `setup:env` and `setup:mcp` are deliberately
// BOOTSTRAP-ONLY — each is a no-op once its target exists, because a hook has no
// business stomping a file a developer has since edited. That is the right
// default for `pnpm install`, and the wrong one after pulling a change that adds
// a key to `.env.example` or a server to `.mcp.json.example`: the templates move
// and the rendered files silently do not, so the new key is simply absent and
// whatever reads it fails somewhere unrelated. This task is the deliberate
// "re-render from the templates" the hook refuses to do on its own.
//
// Backups rather than a prompt. A prompt cannot be answered by CI, a hook, or an
// agent, and "are you sure?" is a poor guard for a file that may hold the only
// copy of real blob-storage credentials. Every replaced file is renamed to
// `<name>.bak.<YYYYMMDD-HHMMSS>` beside itself (gitignored) before anything is
// written, so recovering a hand-edited value is a `diff` away and nothing is
// destroyed. `--no-backup` deletes instead, for when the backups are the mess.
//
// What it touches — exactly the rendered files, never the templates:
//   * services/web/.env               (from .env.example)
//   * services/atproto-cron-sync/.env (from .env.example)
//   * .mcp.json                       (from .mcp.json.example)
//
// Note that a regenerated `services/web/.env` carries a freshly minted
// `BETTER_AUTH_SECRET`, which signs out the local dev server. That is local-only
// and disposable; the previous value is in the backup if you want it back.
//
// Usage:
//   mise run setup:reset                   # back up, then re-render everything
//   mise run setup:reset -- --no-backup    # delete instead of backing up
//   mise run setup:reset -- --dry-run      # print what would move, change nothing

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const args = new Set(process.argv.slice(2));
const noBackup = args.has("--no-backup");
const dryRun = args.has("--dry-run");

/** The rendered files, in the order the renderers below recreate them. */
const TARGETS = [join(root, "services", "web", ".env"), join(root, "services", "atproto-cron-sync", ".env"), join(root, ".mcp.json")];

/** `20260819-231500` — sortable, second-resolution, filename-safe. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// One stamp for the whole run, so a reset's backups sort together rather than
// splitting across a second boundary mid-loop.
const suffix = stamp();
let moved = 0;

for (const target of TARGETS) {
  const label = relative(root, target);
  if (!existsSync(target)) {
    console.log(`reset-config: ${label} is absent — it will just be created.`);
    continue;
  }
  if (dryRun) {
    console.log(`reset-config: would ${noBackup ? "delete" : `back up ${label} → ${label}.bak.${suffix} and`} replace ${label}.`);
    moved++;
    continue;
  }
  if (noBackup) {
    rmSync(target);
    console.log(`reset-config: deleted ${label}.`);
  } else {
    const backup = `${target}.bak.${suffix}`;
    renameSync(target, backup);
    console.log(`reset-config: ${label} → ${relative(root, backup)}`);
  }
  moved++;
}

if (dryRun) {
  console.log(`reset-config: dry run — ${moved} file(s) would be replaced. Nothing changed.`);
  process.exit(0);
}

// Re-render through the same two scripts the postinstall hook uses, rather than
// duplicating their logic. With the targets gone, `setup:env` is no longer a
// no-op; `render-mcp` still needs `--force` because it preserves any locally
// added server by merging into an existing file, and we want the template's
// shape back. Order matters: the MCP render reads DATABASE_URL out of the
// `services/web/.env` the first script writes.
const node = process.execPath;
execFileSync(node, [join(here, "bootstrap-env.mjs")], { stdio: "inherit" });
execFileSync(node, [join(here, "render-mcp.mjs"), "--force"], { stdio: "inherit" });

console.log(
  noBackup
    ? "reset-config: done. Config regenerated from the templates."
    : `reset-config: done. Config regenerated from the templates; the previous files are beside them as *.bak.${suffix}.`,
);
