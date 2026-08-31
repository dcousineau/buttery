#!/usr/bin/env bash
# Run the `db` vitest project against the local dev Postgres.
#
# `pnpm test:db` wraps `railway run`, which needs a Railway login; this reads
# the same DATABASE_URL out of `services/web/.env` directly, which is what a
# cloud session (docs/CLAUDE_CLOUD.md) and a plain `docker compose up` have.
# Only DATABASE_URL is exported — the rest of that file is not needed here and
# some of its placeholder values are not shell-safe to `source`.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATABASE_URL="$(grep -E '^DATABASE_URL=' services/web/.env | head -n1 | cut -d= -f2-)"
export DATABASE_URL
cd services/web
exec ./node_modules/.bin/vitest run --project db "$@"
