#!/usr/bin/env bash
# `pnpm dev` entrypoint: bring up the local dev stack, or attach to the one
# that's already up.
#
# The stack is a singleton — process-compose binds a REST API port, so a second
# `up` would just die on the bind. Attaching instead makes a stray second
# `pnpm dev` (a human in another terminal, an agent that didn't check) do the
# useful thing rather than fail.
set -euo pipefail

cd "$(dirname "$0")/../.."

# A fresh clone has no per-service `.env` files, and every process that touches
# the database or the web server reads one (services/web/.env, and
# services/atproto-cron-sync/.env for the sync one-shot). Create them from their
# examples (no-op once they exist) so the stack boots instead of dying inside
# `migrate` on an undefined DATABASE_URL.
node scripts/dev/bootstrap-env.mjs

# process-compose writes per-process logs here and won't create the directory.
mkdir -p .dev-logs

if process-compose project state >/dev/null 2>&1; then
  echo "Dev stack already running — attaching. (Quitting the TUI leaves it running; \`pnpm dev:down\` stops it.)"
  exec process-compose attach
fi

# Nothing is running, so nothing holds these open: start each boot from empty
# logs. Otherwise `.dev-logs/*.log` accumulate every previous run's output and
# a tail can't tell this boot's errors from last week's.
rm -f .dev-logs/*.log

exec process-compose up "$@"
