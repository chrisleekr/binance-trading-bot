#!/usr/bin/env bash
# Self-test for no-mutated-applied-migration.sh.
#
# The gate's whole value is that it fires on drift no other check can see, so an
# assertion that only proves "the gate exits non-zero" is not enough: the vacuity
# guard also exits non-zero, and a gate whose scan path broke would satisfy every
# negative case while detecting nothing. Each case below asserts the SPECIFIC
# reason string, and the pristine case pins that the gate can still pass at all.
#
# The fixture is generated rather than committed because the interesting states are
# mutations of a known-good tree, and committing decoy *.sql files next to real
# migrations invites someone to mistake them for the real thing.
#
# The manifest writer below is deliberately NOT the gate's own hasher, even though the gate now imports it from migrate.ts. Sharing it would let a broken digest cancel out on both sides: the pristine case would still pass and every mutation case would still fire, because any hash function changes when the body changes. An independent six-line implementation is the cheapest oracle that a wrong-but-consistent digest cannot satisfy.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-mutated-applied-migration.sh"

tmp="$(mktemp -d -t migration-gate-selftest.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

fails=0

# Built once and copied per case: the fixture is fixed printf output, so regenerating its manifest five times recomputes a constant.
mkdir -p "$tmp/pristine"
printf 'create table if not exists alpha (id int);\n' > "$tmp/pristine/0001_alpha.sql"
printf 'create table if not exists beta (id int);\n' > "$tmp/pristine/0002_beta.sql"
MIGRATIONS_DIR="$tmp/pristine" bun -e '
  const fs = require("node:fs"); const path = require("node:path");
  const dir = process.env.MIGRATIONS_DIR;
  const sha256 = async (i) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(i))), (b) => b.toString(16).padStart(2, "0")).join("");
  const out = {};
  // Mirrors the runner selection rule (top-level *.sql only) so the fixture is a fixture of what the gate actually walks.
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".sql")).map((f) => f.name).sort()) out[e] = await sha256(fs.readFileSync(path.join(dir, e), "utf8"));
  fs.writeFileSync(path.join(dir, "checksums.json"), JSON.stringify(out, null, 2) + "\n");
'

# Restores the pristine two-migration fixture with a manifest the gate should accept.
seed_fixture() {
  rm -rf "$tmp/migrations"
  cp -R "$tmp/pristine" "$tmp/migrations"
}

# expect_reject <case-label> <expected-substring>
expect_reject() {
  local label="$1" needle="$2" out rc
  out="$(MIGRATIONS_DIR="$tmp/migrations" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -qF -- "$needle" <<<"$out"; then
    echo "FAIL: $label not rejected for the expected reason '$needle' (rc=$rc)"
    fails=1
  fi
}

# expect_reject_runner <case-label> <runner-path> <expected-substring>
#   expect_reject against a different runner module. The gate imports its file list and its digest from the runner, so a runner it cannot load, or one that throws mid-scan, is a scan that never happened — and neither state can be staged as a directory of .sql files.
expect_reject_runner() {
  local label="$1" runner="$2" needle="$3" out rc
  out="$(MIGRATIONS_DIR="$tmp/migrations" MIGRATIONS_RUNNER="$runner" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! grep -qF -- "$needle" <<<"$out"; then
    echo "FAIL: $label not rejected for the expected reason '$needle' (rc=$rc)"
    fails=1
  fi
}

seed_fixture
if ! MIGRATIONS_DIR="$tmp/migrations" bash "$gate" >/dev/null 2>&1; then
  echo "FAIL: pristine fixture expected exit 0"
  fails=1
fi

# The loud break: a body edit, comment or not, moves the digest and the runner throws.
seed_fixture
printf -- '-- a clarifying comment\n' >> "$tmp/migrations/0001_alpha.sql"
expect_reject "edited migration" "were edited"

# The silent break: renumbering an applied file orphans its ledger row and re-applies the body.
seed_fixture
mv "$tmp/migrations/0001_alpha.sql" "$tmp/migrations/0003_alpha.sql"
expect_reject "renamed migration" "renamed or deleted"

# An unpinned addition would leave the next edit of it invisible to this gate.
seed_fixture
printf 'create table if not exists gamma (id int);\n' > "$tmp/migrations/0003_gamma.sql"
expect_reject "unpinned new migration" "not pinned"

# A deleted manifest must be named, not fall through to a vacuous pass or a raw parse trace.
seed_fixture
rm -f "$tmp/migrations/checksums.json"
expect_reject "missing manifest" "checksum manifest not found"

# Scan-path regression must fail loudly, never pass on an empty walk.
seed_fixture
rm -f "$tmp/migrations"/*.sql
expect_reject "empty migrations directory" "vacuously"

# Three manifests, three different branches, kept apart on purpose: `null` PARSES, so it can only ever reach the shape check, and a case that conflated them would leave the parse catch asserted by nothing.
seed_fixture
printf '{ not json\n' > "$tmp/migrations/checksums.json"
expect_reject "unparseable manifest" "could not read the checksum manifest at"

# Parses, but `Object.keys` on it would answer a TypeError for null and positional indices for an array — either way the comparison below would run against pins that are not filenames.
seed_fixture
printf 'null\n' > "$tmp/migrations/checksums.json"
expect_reject "non-object manifest" "is not a name-to-digest object"

# Parses AND is an object, but a value that is not a digest reaches `expected.slice(0, 12)` in the compare loop, which is past every catch in the gate. Null is the shape to probe: an array would slip through a `.slice` guard, so the check has to be about what a digest IS, not about what happens to have the method.
seed_fixture
printf '{ "0001_alpha.sql": null }\n' > "$tmp/migrations/checksums.json"
expect_reject "non-digest manifest value" "not a SHA-256 digest"

# The two ways the scan itself can fail, reached through the runner seam because neither is expressible as a fixture: the import happens before the directory is looked at, and a read fault inside `loadMigrations` cannot be provoked by file permissions on a CI image that runs as root.
printf 'export const loadMigrations = async () => { throw new Error("EACCES: permission denied"); };\n' > "$tmp/throwing-runner.ts"

seed_fixture
expect_reject_runner "unloadable runner" "$tmp/no-such-runner.ts" "could not load the migration runner from"

seed_fixture
expect_reject_runner "runner that throws mid-scan" "$tmp/throwing-runner.ts" "could not read migrations from"

if [ "$fails" -ne 0 ]; then
  echo "no-mutated-applied-migration self-test: RED"
  exit 1
fi

echo "no-mutated-applied-migration self-test: OK"
