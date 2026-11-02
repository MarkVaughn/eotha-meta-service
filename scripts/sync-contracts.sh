#!/usr/bin/env bash
# Re-vendor the contract bindings from a sibling eotha-contracts checkout into src/lib/contracts/ (compiled
# to ESM with ".js" import specifiers, the same pipeline scripts/check-contract-drift.sh verifies):
#   exploration.js   standalone copy of eotha/rtse/v1/exploration
#   penalty/         relative-import closure of eotha/internal/v1/penalty_delivery (stale files are removed)
# Skips quietly if the checkout is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$ROOT/../eotha-contracts}"
VENDOR="$ROOT/src/lib/contracts"
TOOLS="$ROOT/scripts/lib/contracts-tools.mjs"
# shellcheck source=lib/contracts-lib.sh
. "$ROOT/scripts/lib/contracts-lib.sh"

if [ ! -d "$CONTRACTS" ]; then
  echo "sync-contracts: $CONTRACTS not found; skipping (set CONTRACTS_DIR to override)." >&2
  exit 0
fi

# Rebuild the generated TypeScript bindings from the .proto files.
(cd "$CONTRACTS" && npm run generate)

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
contracts_compile "$CONTRACTS" "$OUT"

for entry in "$CONTRACTS_EXPLORATION_ENTRY" "$CONTRACTS_PENALTY_ENTRY"; do
  if [ ! -f "$OUT/$entry" ]; then
    echo "sync-contracts: compilation produced no $entry." >&2
    exit 1
  fi
done

SHA="$(git -C "$CONTRACTS" rev-parse --short=40 HEAD 2>/dev/null || echo unknown)"

# vendor <generated-file> <destination> <header-line>...
vendor() {
  local src="$1" dest="$2"
  shift 2
  mkdir -p "$(dirname "$dest")"
  { printf '%s\n' "$@"; node "$TOOLS" body "$src"; } > "$dest"
}

exploration_files="$(node "$TOOLS" closure "$OUT" "$CONTRACTS_EXPLORATION_ENTRY")"
if [ "$exploration_files" != "$CONTRACTS_EXPLORATION_ENTRY" ]; then
  echo "sync-contracts: $CONTRACTS_EXPLORATION_ENTRY imports other generated files; the standalone exploration.js cannot hold them." >&2
  exit 1
fi
vendor "$OUT/$CONTRACTS_EXPLORATION_ENTRY" "$VENDOR/exploration.js" \
  "// Vendored from eotha-contracts commit $SHA (gen/ts/eotha/rtse/v1/exploration.ts, compiled to ESM). DO NOT EDIT;" \
  "// regenerate with scripts/sync-contracts.sh when exploration.proto changes."
echo "sync-contracts: wrote $VENDOR/exploration.js"

# Replace the penalty tree wholesale so files dropped from the import closure do not linger.
expected="$(node "$TOOLS" closure "$OUT" "$CONTRACTS_PENALTY_ENTRY")"
rm -rf "$VENDOR/penalty"
while IFS= read -r rel; do
  vendor "$OUT/$rel" "$VENDOR/penalty/$rel" \
    "// Vendored from eotha-contracts commit $SHA (PenaltyDelivery contracts). DO NOT EDIT; regenerate with scripts/sync-contracts.sh."
done <<< "$expected"
echo "sync-contracts: wrote $(printf '%s\n' "$expected" | wc -l | tr -d ' ') files under $VENDOR/penalty"
