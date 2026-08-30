#!/usr/bin/env bash
# Self-test for no-bun-version-skew.sh. Drives the real gate over a known-good
# fixture tree, then over one perturbation per pin site via the GUARD_ROOT
# override.
#
# One fail fixture would only prove the gate can go red for the ONE site it
# perturbs, so every reading gets its own probe: skew that site alone, require
# red, and require the diagnostic to name that file. The `site-removed` probe
# deletes a pin rather than skewing it — the shrink case an "all remaining sites
# agree" check passes and only the exact-count guard catches.
#
# Fixture-side probes cannot reach one whole class of failure, so a second family perturbs the GATE and runs it against the pristine fixture. The gate USED to derive its expectation by summing the registry it validates, which meant deleting a `SITES` row shrank the expectation in lockstep and the narrowed gate reported OK over the sites that remained — a tree that is clean by construction can never show that, because the tree is not what decides how much is enforced. The expectation is a hand-counted literal now, and these probes are what keep it one: they fail the moment it goes back to being computed, and a tenth pin site therefore has to move that literal by hand.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-bun-version-skew.sh"
pass_root="$dir/__fixtures__/bun-version-skew/pass"

fails=0

# One temp root for every probe, allocated once and trapped. `set -u` does not catch a failed
# `mktemp` — the variable is assigned, just empty — so an unguarded `cp -R "$pass_root/." "$tmp/"`
# would copy the fixture tree into `/` and the matching `rm -rf ""` would not clean it up. Every job
# here is interruptible, so the trap also stops a cancelled pipeline leaking a tree per probe.
tmp_root="$(mktemp -d -t bun-version-skew-selftest.XXXXXX)" || {
  echo "FAIL: could not create a temp fixture root"
  exit 1
}
trap 'rm -rf "$tmp_root"' EXIT INT TERM

probe_n=0

# perturb <root> <file> <occurrence> <needle> <replacement>
#   Edits the Nth line containing <needle>. Done in bun rather than sed because
#   BSD sed (dev) and BusyBox sed (CI image) disagree on in-place and
#   occurrence-ranged edits. Exits non-zero if the edit did not apply, so a
#   probe can never pass by silently changing nothing.
perturb() {
  PB_ROOT="$1" PB_FILE="$2" PB_N="$3" PB_FROM="$4" PB_TO="$5" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const p = path.join(process.env.PB_ROOT, process.env.PB_FILE);
const from = process.env.PB_FROM;
const to = process.env.PB_TO;
const want = Number(process.env.PB_N);
let seen = 0;
let applied = false;
const out = fs.readFileSync(p, "utf8").split("\n").map((line) => {
  if (!applied && line.includes(from)) {
    seen++;
    if (seen === want) { applied = true; return to === "" ? null : line.replace(from, to); }
  }
  return line;
}).filter((l) => l !== null).join("\n");
if (!applied) { console.error("perturbation did not apply"); process.exit(1); }
fs.writeFileSync(p, out);
'
}

# probe <label> <file> <occurrence> <needle> <replacement> <expected-substring>
probe() {
  local label="$1" file="$2" occ="$3" from="$4" to="$5" expect="$6"
  local tmp out rc
  probe_n=$((probe_n + 1))
  tmp="$tmp_root/probe-$probe_n"
  if ! mkdir -p "$tmp" || ! cp -R "$pass_root/." "$tmp/"; then
    echo "FAIL: $label — could not stage the pass fixture into $tmp"
    fails=1
    return
  fi
  if ! perturb "$tmp" "$file" "$occ" "$from" "$to"; then
    echo "FAIL: $label — perturbation did not apply to $file (fixture drifted from the gate's patterns)"
    fails=1
  else
    out="$(GUARD_ROOT="$tmp" bash "$gate" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "FAIL: $label — gate stayed GREEN on a skewed $file"
      fails=1
    elif ! grep -q "$expect" <<<"$out"; then
      echo "FAIL: $label — gate went red but never mentioned '$expect':"
      echo "$out"
      fails=1
    fi
  fi
  rm -rf "$tmp"   # reclaim as we go; the EXIT trap covers an interrupted run
}

# gate_probe <label> <occurrence> <needle> <replacement> <expected-substring>
#   Same shape as `probe`, but the perturbation lands on a copy of the GATE and the fixture stays pristine — a narrowed gate is green over a good tree by construction, so the fixture is the wrong place to look for it. `_common.sh` is staged alongside because the gate sources it by its own dirname, and the copy is invoked as `bash <path>` so the source mode of the original never matters.
gate_probe() {
  local label="$1" occ="$2" from="$3" to="$4" expect="$5"
  local staged out rc
  probe_n=$((probe_n + 1))
  staged="$tmp_root/probe-$probe_n"
  if ! mkdir -p "$staged" || ! cp "$gate" "$staged/gate.sh" || ! cp "$dir/_common.sh" "$staged/_common.sh"; then
    echo "FAIL: $label — could not stage the gate into $staged"
    fails=1
    return
  fi
  if ! perturb "$staged" "gate.sh" "$occ" "$from" "$to"; then
    echo "FAIL: $label — perturbation did not apply to the gate (the gate drifted from this probe's anchor)"
    fails=1
  else
    out="$(GUARD_ROOT="$pass_root" bash "$staged/gate.sh" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "FAIL: $label — narrowed gate stayed GREEN over the pass fixture"
      fails=1
    elif ! grep -q "$expect" <<<"$out"; then
      echo "FAIL: $label — gate went red but never mentioned '$expect':"
      echo "$out"
      fails=1
    fi
  fi
  rm -rf "$staged"
}

# Baseline: the good tree must pass, and must report all nine readings. Asserting
# the count is what catches a pattern that silently stopped matching — without it
# a gate reading only eight sites would still look green here.
pass_out="$(GUARD_ROOT="$pass_root" bash "$gate" 2>&1)"
pass_rc=$?
if [ "$pass_rc" -ne 0 ] || ! grep -q '9 pins agree at 9.9.9' <<<"$pass_out"; then
  echo "FAIL: pass fixture expected exit 0 with 9 readings, got rc=$pass_rc: $pass_out"
  fails=1
fi

# One probe per pin site. Each must independently turn the gate red, and the diagnostic must name
# THAT reading — file:line plus the site label. `perturb` picks its target by occurrence index, so a
# filename-only assertion would still pass if a fixture edit shifted two probes onto one site and
# left another unprobed. Naming the reading turns that into a red self-test instead of silent
# narrowing, at the cost of pinning the fixture line numbers, which is the intent.
probe "tool-versions"      ".tool-versions"                  1 "9.9.9" "9.9.8" ".tool-versions:1 (asdf/mise pin)"
probe "packageManager"     "package.json"                    1 "9.9.9" "9.9.8" "package.json (packageManager)"
probe "types-bun"          "package.json"                    2 "9.9.9" "9.9.8" "package.json (@types/bun)"
probe "gh-ci"              ".github/workflows/ci.yml"        1 "9.9.9" "9.9.8" "ci.yml:2 (BUN_VERSION)"
probe "gh-nightly"         ".github/workflows/nightly.yml"   1 "9.9.9" "9.9.8" "nightly.yml:2 (BUN_VERSION)"
probe "gitlab-image"       ".gitlab-ci.yml"                  1 "9.9.9" "9.9.8" ".gitlab-ci.yml:2 (default job image)"
probe "gitlab-bootstrap"   ".gitlab-ci.yml"                  2 "9.9.9" "9.9.8" ".gitlab-ci.yml:6 (BUN_VERSION)"
probe "gitlab-app-e2e"     ".gitlab-ci.yml"                  3 "9.9.9" "9.9.8" ".gitlab-ci.yml:10 (BUN_VERSION)"
probe "dockerfile"         "apps/server/Dockerfile"          1 "9.9.9" "9.9.8" "Dockerfile:1 (ARG BUN_VERSION)"

# The advisory engines floor drifting behind the pinned runtime.
probe "engines-floor"      "package.json"                    1 '">=9.9"' '">=9.8"' "engines.bun floor"

# A range where an exact pin is required. Renovate reaches @types/bun through the
# ordinary npm manager, so a bumped range here is the likeliest way the types
# drift off the runtime they describe.
probe "types-bun-range"    "package.json"                    1 '"9.9.9"' '"^9.9.9"' "pinned exactly"

# Shrink case: a pin site that vanishes rather than disagreeing. Every remaining
# site still agrees, so only the exact-count guard can catch this.
probe "site-removed"       ".tool-versions"                  1 "bun 9.9.9" "" "found 0"

# Shape, not value: the package.json readings are parsed rather than pattern-matched, so a field
# that changes shape has to fail as loudly as one that disagrees.
probe "pm-not-bun"         "package.json"                    1 '"bun@9.9.9"' '"pnpm@9.9.9"' "packageManager is not a"
probe "types-bun-missing"  "package.json"                    1 '"@types/bun"' '"@types/bunx"' "is missing"
probe "engines-shape"      "package.json"                    1 '">=9.9"' '"9.9"'      "engines.bun must be a"
probe "pkg-unparseable"    "package.json"                    1 "{" "{," "not parseable JSON"

# Gate-side probes: the gate is narrowed and pointed at the pristine fixture, because a narrowed gate is green over a good tree by construction and no fixture edit can reach that. Each names the branch it pins, since the four checks below overlap and an assertion that only demanded "red" would be satisfied by whichever one happened to fire.

# Deletes a registry row. The surviving pins still agree AND still match their own declared counts, so nothing about the tree looks wrong from the inside — this is the mutation that passed GREEN before the expectation stopped being a sum over the registry.
gate_probe "sites-row-deleted" 1 '{ file: "apps/server/Dockerfile"' ""            "declare 8 pin readings, but this gate expects 9"

# Lowers a row's declared count below what its file publishes. This does NOT narrow what is read — every match is still pushed — so the collected total is unchanged and it is the registry sum that has to name the drift. The per-site check does go red here too, but its remedy sends the editor to re-register a pin site that never moved.
gate_probe "expect-lowered"    1 '"BUN_VERSION", re: new RegExp(BUN_VERSION_KEY, "gm"), expect: 2' '"BUN_VERSION", re: new RegExp(BUN_VERSION_KEY, "gm"), expect: 1' "declare 8 pin readings, but this gate expects 9"

# Breaks a pattern so its site stops matching, leaving the registry untouched. Only the per-site count can name which file went quiet.
gate_probe "pattern-broken"    1 '"^bun[ \\t]+("' '"^bunx[ \\t]+("' ".tool-versions: expected 1 asdf/mise pin reading(s), found 0"

# Makes a site unreadable at the moment it is read. `existsSync` has already said the path resolves, so this is the window the sibling read of package.json was guarded against and this one was not; the assertion names the site, since an unguarded throw would abort the scan before the other five were ever looked at.
gate_probe "site-unreadable" 1 'content = fs.readFileSync(abs, "utf8");' 'throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });' "could not read pin site .tool-versions"

# Counts a reading without collecting it: the registry is untouched and every per-site count still agrees with its file, so the two checks above are both silent and only the collected total can see the pins that never arrived. Without this probe that branch could be deleted outright and this self-test would still report OK.
gate_probe "reading-not-collected" 1 'readings.push({ where: site.file + ":" + lineOf(content, m.index), label: site.label, value: m[1] });' '' "collected 2."

if [ "$fails" -ne 0 ]; then
  echo "no-bun-version-skew self-test: RED"
  exit 1
fi

echo "no-bun-version-skew self-test: OK (baseline + 21 probes)"
