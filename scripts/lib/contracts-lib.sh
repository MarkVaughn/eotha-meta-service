# Sourced by scripts/check-contract-drift.sh and scripts/sync-contracts.sh: the one pipeline that turns
# generated eotha-contracts TypeScript into the ESM tree vendored under src/lib/contracts/.

# Vendored layout (relative to src/lib/contracts):
#   exploration.js                       standalone copy of eotha/rtse/v1/exploration
#   penalty/<generated tree>             relative-import closure of eotha/internal/v1/penalty_delivery
CONTRACTS_EXPLORATION_ENTRY="eotha/rtse/v1/exploration.js"
CONTRACTS_PENALTY_ENTRY="eotha/internal/v1/penalty_delivery.js"

# contracts_compile <contracts-src-dir> <out-dir>: compile every gen/ts/eotha binding to ESM with ".js"
# import specifiers. --noCheck: the generated code has Node-typing errors under bare tsc
# (Buffer/globalThis) but emits valid JS.
contracts_compile() {
  local src="$1" out="$2" tools
  tools="$(dirname "${BASH_SOURCE[0]}")/contracts-tools.mjs"
  (cd "$src" && files=() && while IFS= read -r f; do files+=("$f"); done < <(find gen/ts/eotha -name '*.ts' | sort) \
    && ./node_modules/.bin/tsc --ignoreConfig "${files[@]}" --outDir "$out" --rootDir gen/ts \
      --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --noCheck) || return 1
  node "$tools" rewrite "$out"
}
