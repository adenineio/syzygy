#!/usr/bin/env bash
# Loads the plugin headlessly and fails on any load/hook error in the debug log.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../syzygy" && pwd)"
log="$(mktemp -t szg-smoke)"

echo "→ loading plugin from $here"
claude --plugin-dir "$here" --debug -p "Reply with the single word: ready" >"$log" 2>&1
status=$?

echo "→ exit $status"
if grep -iE "hook (failed|threw)|does not validate|failed to load|module .* not loaded|syzygy.*error" "$log"; then
  echo "✘ smoke test found plugin errors (full log: $log)"
  exit 1
fi
grep -iE "syzygy" "$log" | head -20
echo "✔ no plugin errors reported (full log: $log)"
