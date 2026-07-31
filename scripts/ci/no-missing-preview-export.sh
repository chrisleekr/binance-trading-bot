#!/usr/bin/env bash
# Preview-export gate. Every registered strategy plugin MUST (1) expose its
# previewLevels module through a "./preview" subpath export, and (2) have an
# entry in the web's lazy preview import map, so apps/web can dynamic-import the
# typed preview builder (issue #593) the same extensible way it imports each
# strategy's event schemas — no code edit in apps/api / apps/worker when a
# strategy is added (CLAUDE.md invariant #1).
#
# The registered set is the single source of truth in
# packages/strategy/registry/src/index.ts; a new strategy is covered here with
# no edit to this gate. Mirrors the grep-gate family (no-plugin-leak.sh): grep
# for the registered @app/strategy-* specifiers, then assert each package.json
# carries the "./preview" export key AND the web map imports "<spec>/preview".
set -euo pipefail

REGISTRY='packages/strategy/registry/src/index.ts'
WEB_MAP='apps/web/src/features/symbol/preview/preview-modules.ts'
bad=0

# Registered strategy specifiers: every @app/strategy-* the registry imports,
# minus the -core contract (infrastructure, not a plugin).
mapfile -t specs < <(
  grep -oE "@app/strategy-[a-z-]+" "$REGISTRY" \
    | grep -vE "^@app/strategy-core$" \
    | sort -u
)

if [[ ${#specs[@]} -eq 0 ]]; then
  echo "no-missing-preview-export gate: no registered strategies found in $REGISTRY" >&2
  exit 1
fi

for spec in "${specs[@]}"; do
  pkgjson="$(grep -rlF "\"name\": \"$spec\"" packages/strategy/*/package.json || true)"
  if [[ -z "$pkgjson" ]]; then
    echo "Preview-export gate: no package.json found for registered strategy $spec"
    bad=1
    continue
  fi
  if ! grep -qE '"\./preview"[[:space:]]*:' "$pkgjson"; then
    echo "Preview-export gate: $spec ($pkgjson) is missing a \"./preview\" export"
    bad=1
  fi
  if ! grep -qF "$spec/preview" "$WEB_MAP"; then
    echo "Preview-export gate: $spec is not in the web preview import map ($WEB_MAP)"
    bad=1
  fi
done

if [[ $bad -ne 0 ]]; then
  echo
  echo 'Every registered strategy must expose a "./preview" subpath export AND'
  echo "have an import('<spec>/preview') entry in $WEB_MAP."
  exit 1
fi

echo 'no-missing-preview-export gate: OK'
