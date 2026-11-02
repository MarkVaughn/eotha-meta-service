#!/usr/bin/env bash
# Fail if the vendored contract JavaScript under src/lib/contracts/ differs from what eotha-contracts
# would generate today. Regenerates from a clean export of the contracts ref in a scratch directory;
# the sibling checkout is never modified.
#
#   CONTRACTS_DIR            eotha-contracts git checkout (default: ../eotha-contracts)
#   CONTRACTS_REF            ref to regenerate from (default: origin/main after a best-effort fetch, else HEAD)
#   CONTRACT_DRIFT_REQUIRE=1 fail instead of skipping when the checkout is absent (use in CI)
#
# Header lines (vendoring provenance comments) are ignored; relative import specifiers are compared
# after the same ".js" rewrite used when vendoring, because the generated TypeScript omits extensions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$ROOT/../eotha-contracts}"
VENDOR="$ROOT/src/lib/contracts"

if [ ! -d "$CONTRACTS/.git" ] && ! git -C "$CONTRACTS" rev-parse --git-dir >/dev/null 2>&1; then
  if [ "${CONTRACT_DRIFT_REQUIRE:-0}" = 1 ]; then
    echo "contract-drift: $CONTRACTS is not a git checkout and CONTRACT_DRIFT_REQUIRE=1." >&2
    exit 1
  fi
  echo "contract-drift: $CONTRACTS not found; skipping (set CONTRACTS_DIR to override)." >&2
  exit 0
fi

REF="${CONTRACTS_REF:-}"
if [ -z "$REF" ]; then
  GIT_TERMINAL_PROMPT=0 git -C "$CONTRACTS" fetch --quiet origin main 2>/dev/null || echo "contract-drift: could not fetch origin/main; using local refs." >&2
  if git -C "$CONTRACTS" rev-parse --verify --quiet origin/main >/dev/null; then REF=origin/main; else REF=HEAD; fi
fi
SHA="$(git -C "$CONTRACTS" rev-parse --verify "$REF^{commit}")"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir "$SCRATCH/src" "$SCRATCH/js"
git -C "$CONTRACTS" archive "$SHA" | tar -x -C "$SCRATCH/src"

echo "contract-drift: regenerating from eotha-contracts $REF ($SHA)"
(cd "$SCRATCH/src" && npm ci --silent && npm run --silent generate >/dev/null)

# Compile every generated eotha/** binding. --noCheck: the generated code has Node-typing errors
# under bare tsc (Buffer/globalThis) but emits valid JS.
(cd "$SCRATCH/src" && mapfile -t files < <(find gen/ts/eotha -name '*.ts' | sort) \
  && ./node_modules/.bin/tsc --ignoreConfig "${files[@]}" --outDir "$SCRATCH/js" --rootDir gen/ts \
    --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --noCheck)

# Same rewrite as when vendoring: add the .js extension to relative imports.
while IFS= read -r f; do
  sed -E -i 's#(from ")(\.\.?/[^"]+)(")#\1\2.js\3#' "$f"
done < <(find "$SCRATCH/js" -name '*.js')

status=0
compare() { # vendored-file generated-file header-lines
  local vendored="$1" generated="$2" header="$3"
  if [ ! -f "$generated" ]; then
    echo "DRIFT: ${vendored#$ROOT/} has no generated counterpart in eotha-contracts $REF" >&2
    status=1
  elif ! diff -u --label "vendored/${vendored#$VENDOR/}" --label "generated/${generated#$SCRATCH/js/}" \
    <(tail -n +"$((header + 1))" "$vendored") "$generated"; then
    echo "DRIFT: ${vendored#$ROOT/} differs from eotha-contracts $REF" >&2
    status=1
  fi
}

compare "$VENDOR/exploration.js" "$SCRATCH/js/eotha/rtse/v1/exploration.js" 2
while IFS= read -r f; do
  compare "$f" "$SCRATCH/js/${f#$VENDOR/penalty/}" 1
done < <(find "$VENDOR/penalty" -name '*.js' | sort)

if [ "$status" -ne 0 ]; then
  echo "contract-drift: vendored contracts are out of date with eotha-contracts $REF ($SHA)." >&2
  exit 1
fi
echo "contract-drift: vendored contracts match eotha-contracts $REF ($SHA)."
