#!/usr/bin/env bash
# Self-test for no-stale-env-contract.sh. Proves the gate can fail.
#
# The gate is one command, and everything it detects hangs off `--check`
# reaching argv in scripts/gen-env-contract.ts. Drop that flag and the generator
# silently takes the WRITE branch: it rewrites env-contract.json to whatever the
# catalogue currently says and exits 0, so the gate goes green forever while
# mirroring nothing. Nothing else in CI would notice, because the file it
# rewrites is the same file the gate reads.
#
# So this drives the real gate over a deliberately stale contract and asserts
# three things: a non-zero exit, the STALE diagnostic specifically (the
# generator also exits 1 from its vacuity floor and its misclassification
# branch, both computed from the catalogue rather than the file, so a bare
# non-zero check would not distinguish them), and that the FIXTURE still holds
# the mutated bytes afterwards. The last one is the direct fail-open probe: the
# write branch would have overwritten it. A fourth assertion probes that
# ENV_CONTRACT_ROOT is honoured at all, since the whole fixture approach rests
# on it.
#
# The stale fixture is a copy in a temp root, reached through the generator's
# ENV_CONTRACT_ROOT override, the same way the other guard self-tests drive
# their gate over a fixture tree with GUARD_ROOT. The tracked env-contract.json
# is only ever read. Mutating it in place instead would leave a truncated or
# stale tracked file behind whenever this script did not run to completion, and
# no trap covers every way that happens.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-stale-env-contract.sh"
root="$(cd -- "$dir/../.." && pwd)"
contract="$root/env-contract.json"

tmp="$(mktemp -d -t no-stale-env-contract-selftest.XXXXXX)" || {
  echo "FAIL: could not create a temp fixture root"
  exit 1
}
trap 'rm -rf "$tmp"' EXIT INT TERM

fixture="$tmp/env-contract.json"
cp "$contract" "$fixture" || {
  echo "FAIL: could not copy env-contract.json into the fixture root"
  exit 1
}

fails=0

# Green on the committed contract, and it must say so. A silent pass would be
# indistinguishable from a gate that never ran.
if out="$(ENV_CONTRACT_ROOT="$tmp" bash "$gate" 2>&1)" && grep -qF 'up to date' <<<"$out"; then
  :
else
  echo "FAIL: gate did not pass cleanly on the committed env-contract.json"
  echo "$out"
  fails=1
fi

# Rename one published variable: the exact drift shape the gate exists to catch,
# and one that leaves the entry count untouched so only the staleness branch can
# fire.
sed 's/"env": "PORT"/"env": "PORT_STALE"/' "$contract" >"$fixture"
if ! grep -qF '"env": "PORT_STALE"' "$fixture"; then
  echo "FAIL: stale fixture did not apply, so the contract's entry shape has changed"
  fails=1
else
  out="$(ENV_CONTRACT_ROOT="$tmp" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: stale contract expected a non-zero exit, got 0"
    echo "$out"
    fails=1
  elif ! grep -qF 'stale: env-contract.json' <<<"$out"; then
    echo "FAIL: stale contract rejected, but not for staleness (rc=$rc)"
    echo "$out"
    fails=1
  fi
  if ! grep -qF '"env": "PORT_STALE"' "$fixture"; then
    echo "FAIL: the gate rewrote the contract instead of checking it."
    echo "      --check is not reaching argv in scripts/gen-env-contract.ts, so the gate cannot fail."
    fails=1
  fi
fi

# The override is the whole reason this is safe, so probe the read path rather
# than assuming it. An empty root has no contract to compare against, which
# `--check` must report as stale; a generator that ignored the override would
# read the tracked file, find it current, and exit 0.
empty="$tmp/empty"
mkdir -p "$empty"
out="$(ENV_CONTRACT_ROOT="$empty" bash "$gate" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] || ! grep -qF 'stale: env-contract.json' <<<"$out"; then
  echo "FAIL: ENV_CONTRACT_ROOT is not being honoured; the gate read the tracked file (rc=$rc)"
  echo "$out"
  fails=1
fi

if [ "$fails" -ne 0 ]; then
  echo "no-stale-env-contract self-test: RED"
  exit 1
fi

echo "no-stale-env-contract self-test: OK"
