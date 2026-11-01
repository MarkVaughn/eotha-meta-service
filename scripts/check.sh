#!/usr/bin/env bash
# Local verification entry point. Usage: scripts/check.sh [fast|full]
#   fast  syntax check of every JS file, Prisma schema validation. No database, no file writes.
#   full  fast, then the gates .github/workflows/ci.yml runs after `npm ci`:
#         build, migrate deploy, schema drift check, test suite. Needs DATABASE_URL (a database ending in _test).
# Each step is named; the first failure names the step and exits non-zero.
set -uo pipefail

mode="${1:-full}"
case "$mode" in fast | full) ;; *) echo "usage: $0 [fast|full]" >&2; exit 2 ;; esac

root="$(git rev-parse --show-toplevel)" || exit 1
cd "$root" || exit 1

step() {
  local name="$1"
  shift
  echo "==> $name"
  if ! "$@"; then
    echo "FAILED: $name" >&2
    exit 1
  fi
}

syntax_check() {
  local f
  while IFS= read -r f; do
    node --check "$f" || return 1
  done < <(git ls-files '*.js' '*.mjs')
}

validate_schema() {
  # validate only parses the schema; the URL is never connected to.
  DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/validate_only}" npx prisma validate
}

require_test_database() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is not set; point it at a dedicated Postgres database whose name ends in _test." >&2
    return 1
  fi
  local name
  name="$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).pathname.slice(1))')" || return 1
  case "$name" in
    *_test) ;;
    *) echo "Refusing to migrate or test database \"$name\": its name must end in _test." >&2; return 1 ;;
  esac
}

step "syntax check (node --check)" syntax_check
step "prisma schema validation" validate_schema
[ "$mode" = fast ] && { echo "check:fast passed"; exit 0; }

export NODE_ENV=test
step "test database guard" require_test_database
step "build (prisma generate)" npm run build
step "prisma migrate deploy" npx prisma migrate deploy
step "schema drift check" npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
step "test suite (npm test)" npm test
echo "check passed"
