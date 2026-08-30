#!/usr/bin/env bash
# Proves both precision patterns and every inventory-refusal branch stay live, with actionable file and source evidence rather than an unrelated non-zero exit.
#
# Sites are pattern-identified, normalized source lines compared as sorted multisets without line numbers; `line-shift` proves movement does not churn the inventory.
#
# Fixtures are plain files under __fixtures__/tofixed-inventory; GUARD_ROOT points the gate at one of them.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-unreviewed-tofixed.sh"
fixtures="$dir/__fixtures__/tofixed-inventory"
fails=0

if [ ! -f "$gate" ]; then
  echo "FAIL: gate script not found at $gate"
  echo 'no-unreviewed-tofixed self-test: RED'
  exit 1
fi

# Reject `$1` and require every remaining argument to appear in the gate's output.
expect_reject() {
  local name="$1"; shift
  local out rc needle
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $name expected a non-zero exit, got 0"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL: $name rejected without '$needle' evidence"
      echo "--- gate output ---"
      echo "$out"
      echo "-------------------"
      fails=1
    fi
  done
}

expect_accept() {
  local name="$1" out rc
  out="$(GUARD_ROOT="$fixtures/$name" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $name expected exit 0, got $rc"
    echo "--- gate output ---"
    echo "$out"
    echo "-------------------"
    fails=1
  fi
}

# An inventory that matches the tree exactly is the only accepted state.
expect_accept pass

# Same sites, moved and reordered: the pin is text-keyed, so this must stay green.
expect_accept line-shift

# A features file with a .toFixed( site and no inventory entry at all.
expect_reject unregistered-file \
  'apps/web/src/features/symbol/components/rogue.tsx' \
  'n.toFixed(3)'

# A registered features site keeps the old scan non-vacuous while an unreviewed .toFixed site sits elsewhere under apps/web/src.
expect_reject outside-features \
  'apps/web/src/shared/lib/money.ts' \
  'n.toFixed(3)'

# Fixed-two locale formatting can span an option object over several lines, and must be found independently of the .toFixed spelling above.
expect_reject multiline-fixed-two \
  'apps/web/src/features/profile/components/quote.tsx' \
  'maximumFractionDigits: 2'

# A registered file that grew a second site the reviewer never saw.
expect_reject added-site \
  'apps/web/src/features/profile/components/gauge.tsx' \
  'n.toFixed(6)'

# A registered site whose text changed: both the vanished and the arrived text
# must be reported, or the reviewer cannot tell what actually moved.
expect_reject edited-site \
  'apps/web/src/features/profile/components/gauge.tsx' \
  'n.toFixed(8)' \
  'n.toFixed(2)'

# An inventory entry whose site no longer exists — the file was cleaned up but
# the pin was left behind, so it now protects nothing and hides the next add.
expect_reject stale-entry \
  'apps/web/src/features/backtest/components/score.tsx' \
  'n.toFixed(4)'

# Nothing under apps/web/src at all must be an explicit refusal, and the sentence is asserted with the root named: the shorter phrase would also be satisfied by a zero-file refusal raised over some other tree.
expect_reject vacuous 'scan matched no .ts/.tsx files under apps/web/src —'

# The other half of the same failure, and the half a floor cannot see: components still under apps/web/src, but not the entry point the walk is anchored on. The count stays healthy, so only the anchor sentence separates this from a clean tree.
expect_reject reject-narrowed-walk 'walk narrowed' 'apps/web/src/main.tsx'

# The three refusals that are not drift: without these the branches could be
# broken or unreachable and this self-test would still print OK.
expect_reject missing-inventory 'missing inventory at' 'scripts/ci/tofixed-inventory.json'
expect_reject invalid-json 'is not valid JSON'
expect_reject blank-reason \
  'missing reason' \
  'apps/web/src/features/profile/components/gauge.tsx'

# An old-format site without its pattern id must identify the refusal, file, and exact unprefixed site.
expect_reject missing-pattern-identity \
  'missing pattern identity' \
  'apps/web/src/features/profile/components/gauge.tsx' \
  'site: export const pct = (n: number): string => `${n.toFixed(2)}%`;'

if [ "$fails" -ne 0 ]; then
  echo 'no-unreviewed-tofixed self-test: RED'
  exit 1
fi

echo 'no-unreviewed-tofixed self-test: OK'
