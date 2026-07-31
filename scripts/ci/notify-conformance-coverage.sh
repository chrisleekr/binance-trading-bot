#!/usr/bin/env bash
# Gate: every @app/notify provider has a sibling test that runs the
# conformance harness. A new provider without conformance coverage is the
# exact failure mode RFC-5 exists to prevent — a manifest that compiles
# and unit-tests in isolation but skips the registry contract.

set -euo pipefail

# Derive the root from this script's location, not `git rev-parse`: the lint
# job runs in the bun:alpine CI image, which has no git.
REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
PROVIDERS_DIR="$REPO_ROOT/packages/notify/src/providers"
TESTS_DIR="$REPO_ROOT/packages/notify/__tests__"
HARNESS_IMPORT='@app/notify/test-harness'

missing=0
for src in "$PROVIDERS_DIR"/*.ts; do
  [ -e "$src" ] || continue
  base=$(basename "$src" .ts)
  test_file="$TESTS_DIR/$base.test.ts"
  if [ ! -f "$test_file" ]; then
    echo "notify-conformance-coverage: missing test file for provider '$base' (expected $test_file)" >&2
    missing=1
    continue
  fi
  if ! grep -q "$HARNESS_IMPORT" "$test_file"; then
    echo "notify-conformance-coverage: $test_file does not import '$HARNESS_IMPORT' — every provider test must run runNotifyProviderConformance" >&2
    missing=1
    continue
  fi
  # The import alone is not enough — a stray `import {} from '...'` would
  # satisfy the grep but skip the harness. Require an actual call-site so
  # the gate breaks when someone deletes the call but forgets the import.
  if ! grep -Eq 'runNotifyProviderConformance[[:space:]]*\(' "$test_file"; then
    echo "notify-conformance-coverage: $test_file imports the harness but never calls runNotifyProviderConformance(...)" >&2
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "" >&2
  echo "Fix: add 'import { runNotifyProviderConformance } from \"@app/notify/test-harness\";'" >&2
  echo "     and call it with provider + fixtures in the missing test file(s)." >&2
  exit 1
fi

echo "notify-conformance-coverage: OK"
