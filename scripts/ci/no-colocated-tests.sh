#!/usr/bin/env bash
# Tests must live under <package>/__tests__/. Co-locating *.test.ts(x) inside src/
# leaves test code in the production tsc graph and the shipped dist tree.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

mapfile -t hits < <(
  find "$repo_root/apps" "$repo_root/packages" \
    -path '*/src/*.test.*' \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    2>/dev/null
)

if [[ ${#hits[@]} -gt 0 ]]; then
  echo "ERROR: co-located tests found under src/. Move them to __tests__/ mirroring src/." >&2
  printf '  %s\n' "${hits[@]}" >&2
  exit 1
fi
