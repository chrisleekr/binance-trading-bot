#!/usr/bin/env bash
# Self-test for no-dropped-lint-rule.sh. Drives the real gate over mutated
# copies of .oxlintrc.json via the OXLINT_CONFIG override, so the tracked config
# is never edited — a killed run cannot leave a disarmed rule behind.
#
# Every failing case asserts its OWN diagnostic, never a bare non-zero exit. The
# gate exits 1 from the vacuity floor, from either diagnostic branch, and from
# `set -e` if oxlint itself fails on a mangled config; a non-zero-means-caught
# check would read any of those as a successful catch.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-dropped-lint-rule.sh"
config="$(cd -- "$dir/../.." && pwd)/.oxlintrc.json"

repo_root="$(cd -- "$dir/../.." && pwd)"

tmp="$(mktemp -d)"

# The probe has to live under apps/web/src — the positive control below proves
# the rule REACHES files there — but the trap deletes whatever this names, so a
# fixed path would destroy a same-named file that already existed and two runs
# would race on it. mktemp -d owns a fresh directory instead. Trailing Xs only:
# BSD mktemp leaves a template's Xs literal when a suffix follows them, handing
# back exactly the fixed path this avoids.
probe_dir="$(mktemp -d "$repo_root/apps/web/src/__lint_probe__.XXXXXX")"
probe="$probe_dir/probe.tsx"
trap 'rm -rf "$tmp" "$probe_dir"' EXIT INT TERM

fails=0

# expect_reject <label> <mutated-config> <substring...>
expect_reject() {
  local label="$1" cfg="$2"
  shift 2
  local out rc needle
  out="$(OXLINT_CONFIG="$cfg" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $label expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $label rejected, but not for '$needle' (rc=$rc)"
      fails=1
    fi
  done
}

# Green on the committed config, and it must say so — a silent pass would be
# indistinguishable from a gate that never ran.
if out="$(bash "$gate" 2>&1)" && grep -qF 'no-dropped-lint-rule gate: OK' <<<"$out"; then
  :
else
  echo "FAIL: gate did not pass cleanly on the committed config"
  echo "$out"
  fails=1
fi

# Only the two SILENT drift shapes are fixtured. A misspelled rule or an unknown
# plugin prefix makes oxlint itself exit 1 before the gate can read the resolved
# config, so a fixture for those would prove nothing about the gate's own logic.

# Silent shape 1: the plugin is dropped from `plugins`. Setting that array
# overwrites oxlint's defaults and `react` is not among them, so every react
# rule leaves the resolved config with no diagnostic and exit 0.
sed 's#"typescript", "import", "oxc", "react"#"typescript", "import", "oxc"#' \
  "$config" > "$tmp/no-plugin.json"
if grep -qF '"react"' "$tmp/no-plugin.json"; then
  echo "FAIL: plugins-array fixture did not apply — the plugins line has changed shape"
  fails=1
else
  expect_reject "react plugin dropped" "$tmp/no-plugin.json" \
    "react/no-unstable-nested-components" "absent entirely"
fi

# Silent shape 2: severity downgraded to warn. The rule still runs, but lint.sh
# invokes oxlint without --deny-warnings, so it can never fail the build.
sed 's#"react/no-unstable-nested-components": "error"#"react/no-unstable-nested-components": "warn"#' \
  "$config" > "$tmp/downgraded.json"
if grep -qF '"react/no-unstable-nested-components": "error"' "$tmp/downgraded.json"; then
  echo "FAIL: severity fixture did not apply — the rule entry has changed shape"
  fails=1
else
  expect_reject "severity downgraded" "$tmp/downgraded.json" \
    "react/no-unstable-nested-components" "different severity"
fi

# Positive control. The checks above prove the rule is present at the right
# severity in the resolved config; they cannot prove it RUNS on the files it
# protects. Adding `apps/web/**` to ignorePatterns, or an overrides entry
# turning it off there, leaves the rules map untouched and the gate green while
# the rule applies to nothing. Lint a real web file that trips it.
cat > "$probe" <<'TSX'
export function Outer() {
  const Inner = () => <span />;
  return <Inner />;
}
TSX
out="$(bunx oxlint "$probe" 2>&1)" && rc=0 || rc=$?
rm -rf "$probe_dir"
if [ "$rc" -eq 0 ] || ! grep -qF 'no-unstable-nested-components' <<<"$out"; then
  echo "FAIL: react/no-unstable-nested-components did not fire on a file under apps/web/src."
  echo "      It is armed in the config but reaches no files — check ignorePatterns and overrides."
  fails=1
fi

exit "$fails"
