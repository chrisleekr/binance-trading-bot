#!/usr/bin/env bash
# Self-test for no-backfilled-migration.sh.
#
# The gate exists to make it structurally impossible to add a migration that sorts below an already-shipped one, because a backfilled file re-runs one-shot data statements against databases that already applied everything above it. Neither of the obvious oracles can see that: checksums.json gains its line in the same commit as the migration, and both CI providers clone shallow so there is no merge-base to diff against. The gate therefore reasons from the directory listing alone, which makes its three grandfather constants load-bearing — the pristine case below is what proves they are still real.
#
# A bare "exits non-zero" assertion would be satisfied by the vacuity guard alone, so a gate whose scan path had broken would look green on every negative case while detecting nothing. Each case asserts its own branch-unique diagnostic substring instead.
#
# The fixture is generated rather than committed: committing decoy *.sql files next to real migrations invites someone to mistake them for the real thing, and the interesting states are all mutations of a known-good tree.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
gate="$dir/no-backfilled-migration.sh"

tmp="$(mktemp -d -t backfilled-migration-selftest.XXXXXX)" || exit 1
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then
  echo "FAIL: could not create a temporary fixture directory"
  exit 1
fi
trap 'rm -rf "$tmp"' EXIT

fails=0

# A faithful miniature of packages/db/migrations: a dense run with the two retired numbers absent, the one grandfathered duplicate pair, and the one grandfathered letter-suffixed file. The exact 0070_* and 0075a_* names are the gate's hardcoded constants, so the pristine case fails the moment either constant stops naming a real file.
# 70 is skipped in the loop because the two explicit 0070_* files supply that number; a third file at 70 would trip the duplicate branch in the pristine case.
mkdir -p "$tmp/pristine"
for n in $(seq 1 79); do
  case "$n" in
    2 | 70 | 78) continue ;;
  esac
  printf 'select 1;\n' > "$tmp/pristine/$(printf '%04d' "$n")_stub_table.sql"
done
printf 'select 1;\n' > "$tmp/pristine/0070_drop_technicals_recommendations.sql"
printf 'select 1;\n' > "$tmp/pristine/0070_first_class_accounts.sql"
printf 'select 1;\n' > "$tmp/pristine/0075a_action_logs_root_heap_drain.sql"
printf '{}\n' > "$tmp/pristine/checksums.json"

# Restores the pristine miniature the gate should accept.
seed_fixture() {
  rm -rf "$tmp/migrations"
  cp -R "$tmp/pristine" "$tmp/migrations"
}

# plant <filename> — adds one migration to the seeded fixture.
plant() {
  printf 'select 1;\n' > "$tmp/migrations/$1"
}

# expect_reject <case-label> <expected-substring>
expect_reject() {
  local label="$1" needle="$2" out rc
  out="$(MIGRATIONS_DIR="$tmp/migrations" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qF -- "$needle"; then
    echo "FAIL: $label not rejected for the expected reason '$needle' (rc=$rc)"
    fails=1
  fi
}

# expect_reject_all <case-label> <expected-substring>... — for a fixture that must trip SEVERAL branches at once, which a single-needle assertion cannot distinguish from a gate that stopped at the first.
expect_reject_all() {
  local label="$1" out rc needle
  shift
  out="$(MIGRATIONS_DIR="$tmp/migrations" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: $label expected a rejection (rc=$rc)"
    fails=1
    return
  fi
  for needle in "$@"; do
    if ! printf '%s\n' "$out" | grep -qF -- "$needle"; then
      echo "FAIL: $label rejected without reporting '$needle'"
      fails=1
    fi
  done
}

# expect_reject_only <case-label> <expected-substring> <forbidden-substring> — asserting the right diagnostic appeared says nothing about a wrong one appearing beside it.
expect_reject_only() {
  local label="$1" needle="$2" forbidden="$3" out rc
  out="$(MIGRATIONS_DIR="$tmp/migrations" bash "$gate" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] || ! printf '%s\n' "$out" | grep -qF -- "$needle"; then
    echo "FAIL: $label not rejected for the expected reason '$needle' (rc=$rc)"
    fails=1
  fi
  if printf '%s\n' "$out" | grep -qF -- "$forbidden"; then
    echo "FAIL: $label also reported '$forbidden', which must not apply to it"
    fails=1
  fi
}

# The pass case asserts the count, not just exit 0: a gate that walked a subset of the listing would still exit 0 while its number set silently narrowed.
seed_fixture
pristine_out="$(MIGRATIONS_DIR="$tmp/migrations" bash "$gate" 2>&1)"
pristine_rc=$?
if [ "$pristine_rc" -ne 0 ]; then
  echo "FAIL: pristine fixture expected exit 0 (rc=$pristine_rc)"
  echo "$pristine_out"
  fails=1
elif ! printf '%s\n' "$pristine_out" | grep -qF -- "OK (79 migrations, max 0079)"; then
  echo "FAIL: pristine fixture passed without reporting the scanned count"
  echo "$pristine_out"
  fails=1
fi

# A name the runner's sort cannot order against the rest.
seed_fixture
plant 0094-bad-name.sql
expect_reject_only "malformed filename" "does not match the required NNNN_name.sql filename shape" "gap in the migration sequence"

# The letter-suffix escape hatch is grandfathered for exactly one file, not open to new ones.
seed_fixture
plant 0094a_x.sql
expect_reject "new letter-suffixed migration" "does not match the required NNNN_name.sql filename shape"

# Two files at one number apply in an order the number does not determine. This case also opens holes 80..93, which pins that the duplicate is reported rather than masked by the hole branch.
seed_fixture
plant 0094_a.sql
plant 0094_b.sql
expect_reject_all "duplicate migration number" "two migrations claim the same sequence number" "gap in the migration sequence"

# A retired number is retired forever: reusing it sorts the new file below everything already shipped above it.
seed_fixture
plant 0078_x.sql
expect_reject "retired number reuse" "claims a retired sequence number"

# A number below the floor sorts ahead of every shipped file while leaving no gap behind it, so only a subset check can see it — the one backfill that passes every other branch.
seed_fixture
plant 0000_x.sql
expect_reject "below-floor number" "numbered below the 0001 sequence floor"

# A gap is where a backfilled migration lands, so the gap itself is the thing to refuse.
seed_fixture
plant 0081_x.sql
expect_reject_all "gap in the sequence" "gap in the migration sequence" "number (0080)" "add it to RETIRED_NUMBERS instead of reusing it"

# Scan-path regression must fail loudly, never pass on an empty walk.
seed_fixture
rm -f "$tmp/migrations"/*.sql
expect_reject "empty migrations directory" "scanned 0 .sql files"

# The other vacuity predicate: files were found, none carried a number. Folded into the first, this state reaches Math.max over an empty set and prints -Infinity as the number to take. The stale branch would still fail the run — every unnumbered state implies the grandfathered pair is missing — so this predicate is about the diagnostic being usable, not about the exit code.
seed_fixture
for f in "$tmp/migrations"/*.sql; do
  case "$f" in
    *0075a_action_logs_root_heap_drain.sql) ;;
    *) rm -f "$f" ;;
  esac
done
expect_reject "no numbered migrations" "parsed 0 sequence numbers"

# A grandfather entry that stops naming a file whitelists that filename forever, below the floor included.
seed_fixture
rm -f "$tmp/migrations/0075a_action_logs_root_heap_drain.sql"
expect_reject_only "stale grandfather entry" "grandfathered filename no longer names a migration" "Give the new migration the next unused number"

# The precondition branch: a missing directory must be named, not fall through to a vacuous pass or a raw fs trace.
rm -rf "$tmp/migrations"
expect_reject "missing migrations directory" "migrations directory not found"

# A path that exists but is not a directory: existsSync is true, readdirSync throws ENOTDIR, and the throw must be named rather than inherited from the runtime.
rm -rf "$tmp/migrations"
printf '' > "$tmp/migrations"
expect_reject "migrations path is not a directory" "could not read migrations from"
rm -f "$tmp/migrations"

if [ "$fails" -ne 0 ]; then
  echo "no-backfilled-migration self-test: RED"
  exit 1
fi

echo "no-backfilled-migration self-test: OK"
