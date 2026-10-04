#!/usr/bin/env bash
# Re-vendor the exploration schema from a sibling eotha-contracts checkout into
# src/lib/contracts/exploration.js (compiled to ESM). Skips quietly if the checkout is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${CONTRACTS_DIR:-$ROOT/../eotha-contracts}"
SRC="gen/ts/eotha/rtse/v1/exploration.ts"
DEST="$ROOT/src/lib/contracts/exploration.js"

if [ ! -d "$CONTRACTS" ]; then
  echo "sync-contracts: $CONTRACTS not found; skipping (set CONTRACTS_DIR to override)." >&2
  exit 0
fi

# Rebuild the generated TypeScript bindings from the .proto files.
(cd "$CONTRACTS" && npm run generate)

if [ ! -f "$CONTRACTS/$SRC" ]; then
  echo "sync-contracts: $CONTRACTS/$SRC was not generated." >&2
  exit 1
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

# The generated file has Node-typing errors under bare tsc (Buffer/globalThis) but still emits
# valid JS, so type errors are tolerated and only a missing output is fatal.
(cd "$CONTRACTS" && ./node_modules/.bin/tsc --ignoreConfig "$SRC" --outDir "$OUT" \
  --target es2022 --module esnext --moduleResolution bundler --skipLibCheck) || true

if [ ! -f "$OUT/exploration.js" ]; then
  echo "sync-contracts: compilation produced no output." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
{
  echo "// Vendored from eotha-contracts (gen/ts/eotha/rtse/v1/exploration.ts, compiled to ESM). DO NOT EDIT;"
  echo "// regenerate from the contracts repo when exploration.proto changes."
  cat "$OUT/exploration.js"
} > "$DEST"

echo "sync-contracts: wrote $DEST"
