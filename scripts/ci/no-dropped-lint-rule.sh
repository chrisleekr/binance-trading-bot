#!/usr/bin/env bash
# Assert against the RESOLVED oxlint config that the rules carrying a repo
# invariant are still armed.
#
# oxlint already hard-fails on a misspelled rule or an unknown plugin prefix, so
# those need no gate. Two drift shapes are silent, and both exit 0:
#
#   1. A plugin removed from `plugins`. Setting that array overwrites oxlint's
#      defaults, and `react` is not among them, so trimming the list makes every
#      react rule vanish from the resolved config with no diagnostic.
#   2. A severity downgraded to `warn`. The rule still runs, but `bunx oxlint`
#      is invoked without `--deny-warnings`, so warnings never fail the build.
#
# Either one silently retires an invariant. Verified against oxlint 1.73.0 by
# no-dropped-lint-rule.selftest.sh, which drives both shapes.

set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
# Seam so the self-test can point at a mutated copy instead of editing the
# tracked config in place.
config="${OXLINT_CONFIG:-$repo_root/.oxlintrc.json}"

# Rules whose absence would remove a repo invariant rather than merely relax
# style. Format: <rule name><TAB><expected severity in the resolved config>.
required_rules=(
  "react/no-unstable-nested-components	deny"
  "import/no-cycle	deny"
)

if [[ ${#required_rules[@]} -eq 0 ]]; then
  echo "ERROR: no rules asserted — this gate would pass vacuously." >&2
  exit 1
fi

# Whitespace-stripped so both shapes appear verbatim as substrings: a bare
# `"rule":"deny"` and a rule carrying options, `"rule":["deny",{...}]`.
resolved="$(bunx oxlint --config "$config" --print-config | tr -d ' \n')"

failed=0
for entry in "${required_rules[@]}"; do
  rule="${entry%%	*}"
  want="${entry##*	}"
  if printf '%s' "$resolved" | grep -qF "\"$rule\":\"$want\"" ||
    printf '%s' "$resolved" | grep -qF "\"$rule\":[\"$want\""; then
    continue
  fi
  echo "ERROR: oxlint rule '$rule' is not '$want' in the resolved config." >&2
  if printf '%s' "$resolved" | grep -qF "\"$rule\":"; then
    echo "  It resolved to a different severity. A 'warn' does not fail the build," >&2
    echo "  because lint.sh runs oxlint without --deny-warnings." >&2
  else
    echo "  It is absent entirely — its plugin is missing from the 'plugins' array" >&2
    echo "  in .oxlintrc.json, or oxlint renamed or removed the rule." >&2
  fi
  failed=1
done

[[ $failed -eq 0 ]] || exit 1
echo "no-dropped-lint-rule gate: OK (${#required_rules[@]} rules armed)"
