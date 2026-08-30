#!/usr/bin/env bash
# Forbid adding a migration that sorts BELOW one that has already shipped.
#
# `packages/db/src/migrate.ts` applies files in name order and skips any name already in `_app_migrations`. A file inserted below the high-water mark therefore runs in its sorted position on a fresh database, but on every already-migrated database it runs LAST — after everything above it. Schema statements survive that; one-shot DATA statements do not, and neither does a repair whose correctness depended on running before some later file.
#
# Neither obvious oracle can see it. `migrations/checksums.json` gains the new file's line in the same commit as the file, so it cannot tell "shipped" from "added on this branch". A merge-base diff resolves to nothing because both CI providers clone shallow. What is left is the directory listing, which is enough: a dense, gap-free, letter-suffix-free sequence has exactly one legal place to add a file, and that is the top.
#
# Stated as sets, so the checks below read as one invariant rather than a pile of ad-hoc rules: the used numbers must be a SUBSET of {1..max}, and `used union retired` must EQUAL {1..max}. The subset half is what rejects a number below the floor — `0000` sorts ahead of every shipped file while leaving no gap behind it, so only the subset half can see it. The equality half is what rejects a hole left open in the middle.
#
# That makes the three exception sets below load-bearing, so they are hardcoded rather than read from the environment — a reviewed grandfather list that any caller can widen is a silent bypass, not an exception. MIGRATIONS_DIR is the only seam, so the paired self-test can aim the gate at a fixture and prove each branch still fires; `lint.sh` clears it before the real run so an ambient value cannot redirect the gate, and the success line names the directory it actually walked.
#
# The escape hatch is deliberate and narrow: a migration that must sort below a shipped one (the only real case so far is repairing a shipped migration that already fails on live data, where a forward-numbered fix can never be reached) adds its filename to GRANDFATHERED_FILES in the same merge request. Explicit, reviewed, and visible in the diff. An entry that stops naming a real file is itself a finding — it whitelists that filename forever, below the floor included.
#
# The file list comes from `loadMigrations` in the runner, never from a copy of its selection rule: a hand-copy makes "the gate numbers what production applies" a comment rather than a fact, and a rule that drifted there would leave this gate reasoning about a different set of files than the ones that actually run.
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-backfilled-migration

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_DIR="${MIGRATIONS_DIR:-$root/packages/db/migrations}" \
GUARD_RUNNER="$root/packages/db/src/migrate.ts" \
bun -e '
const fs = require("node:fs");

const dir = process.env.GUARD_DIR;

const errMsg = (err) => (err && err.message ? err.message : String(err));

// The runner itself, so the gate walks the files production applies rather than the ones a re-implemented filter happens to match.
let loadMigrations;
try {
  ({ loadMigrations } = await import(process.env.GUARD_RUNNER));
} catch (err) {
  console.error("could not load the migration runner from " + process.env.GUARD_RUNNER + ": " + errMsg(err));
  process.exit(1);
}

// Sorts below 0076 on purpose: 0076 ships a `set not null` that already fails where hypertable root-heap rows were stranded, and the apply loop rolls back and throws at the first failing file, so a forward-numbered repair could never run.
const GRANDFATHERED_FILES = new Set(["0075a_action_logs_root_heap_drain.sql"]);
// Benign: these two landed in an order that matches their sorted order, so neither ever ran after the other.
const GRANDFATHERED_DUPES = new Map([[70, ["0070_drop_technicals_recommendations.sql", "0070_first_class_accounts.sql"]]]);
// Numbers that were claimed and released before shipping. Retired forever: reusing one puts the new file below everything already applied above it.
const RETIRED_NUMBERS = new Set([2, 78]);

const SHAPE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const pad = (n) => String(n).padStart(4, "0");
// Filenames are attacker-influenced (git permits newlines and control sequences in a path component), so they are quoted wherever they reach the log rather than pasted in raw.
const show = (name) => JSON.stringify(name);

if (!fs.existsSync(dir)) {
  console.error("migrations directory not found: " + dir + " — scan-path regression in this gate.");
  process.exit(1);
}

// existsSync is true for a plain file too, so ENOTDIR is reachable here, as are EACCES and EMFILE. Whether an uncaught throw fails the process is a property of the runtime, not of this file, and a bun release has already exited 0 on one — so the failure is made explicit rather than inherited.
let files;
try {
  files = (await loadMigrations(dir)).map((m) => m.name);
} catch (err) {
  console.error("could not read migrations from " + dir + ": " + errMsg(err));
  process.exit(1);
}

// Two different faults, so two different messages: an empty walk is a scan-path regression, while a walk that found files it could not number is a naming regression. Folding them together would leave the second untested and its own diagnostic unwritten.
if (files.length === 0) {
  console.error("scanned 0 .sql files in " + dir + " — refusing to pass vacuously.");
  process.exit(1);
}

const malformed = [];
const byNumber = new Map();
for (const name of files) {
  // A grandfathered or malformed name contributes NO number. Parsing one anyway would make 0075a collide with 0075, and would let a rejected name drag the maximum upward and manufacture a phantom run of holes below it.
  if (GRANDFATHERED_FILES.has(name)) continue;
  if (!SHAPE.test(name)) {
    malformed.push(show(name));
    continue;
  }
  const n = Number(name.slice(0, 4));
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(name);
}

if (byNumber.size === 0) {
  console.error("parsed 0 sequence numbers from " + files.length + " .sql files in " + dir + " — refusing to pass vacuously. Unnumbered: " + files.map(show).join(", "));
  process.exit(1);
}

// A grandfather entry that no longer names a file is a filename whitelisted forever, reusable below the floor by anyone who recreates it.
const present = new Set(files);
const stale = [];
for (const name of GRANDFATHERED_FILES) if (!present.has(name)) stale.push(show(name));
for (const [n, names] of GRANDFATHERED_DUPES) {
  for (const name of names) if (!present.has(name)) stale.push(show(name) + " (grandfathered duplicate at " + pad(n) + ")");
}

const numbers = [...byNumber.entries()].sort((a, b) => a[0] - b[0]);

const duplicates = [];
for (const [n, names] of numbers) {
  if (names.length < 2) continue;
  const allowed = GRANDFATHERED_DUPES.get(n);
  if (allowed && allowed.length === names.length && allowed.every((f) => names.includes(f))) continue;
  duplicates.push(pad(n) + " (" + names.map(show).join(", ") + ")");
}

// Kept apart from the gap branch on purpose: the two faults have opposite remedies — a retired number must be abandoned, a gap must be closed by taking the first free number — so one predicate covering both would print the wrong instruction half the time.
const retired = [];
for (const [n, names] of numbers) {
  if (RETIRED_NUMBERS.has(n)) retired.push(pad(n) + " (" + names.map(show).join(", ") + ")");
}

// The sequence starts at 0001. A lower number is not a gap and must not be reported as one: it sorts AHEAD of every shipped migration, so the remedy is renumbering upward to the top, the opposite of filling or retiring a hole.
const belowFloor = [];
for (const [n, names] of numbers) {
  if (n < 1) belowFloor.push(pad(n) + " (" + names.map(show).join(", ") + ")");
}

const max = Math.max(...byNumber.keys());
const gaps = [];
for (let n = 1; n <= max; n++) {
  if (!byNumber.has(n) && !RETIRED_NUMBERS.has(n)) gaps.push(pad(n));
}

// The offending file is already counted in max, so max + 1 would advise a number one past the one to take. The first gap IS the first free number whenever one exists.
const nextFree = gaps.length > 0 ? gaps[0] : pad(max + 1);

// Every triggered branch is reported, never just the first: a duplicate added well above the high-water mark also opens a run of gaps, and a gate that stopped at the gap branch would never name the duplicate that caused it.
const problems = [
  [malformed, "Backfill risk: a migration filename does not match the required NNNN_name.sql filename shape:"],
  [duplicates, "Backfill risk: two migrations claim the same sequence number:"],
  [retired, "Backfill risk: a migration claims a retired sequence number:"],
  [belowFloor, "Backfill risk: a migration is numbered below the 0001 sequence floor:"],
  [gaps, "Backfill risk: a gap in the migration sequence invites a backfilled migration:"],
  [stale, "Backfill risk: a grandfathered filename no longer names a migration:"],
].filter(([list]) => list.length > 0);

if (problems.length > 0) {
  for (const [list, heading] of problems) {
    console.error(heading);
    console.error(list.map((m) => "  " + m).join("\n"));
  }
  console.error("");
  // A stale grandfather entry is not a numbering fault: nobody is adding a migration, so the advice below would name a number nothing is looking for.
  if (problems.some(([list]) => list !== stale)) {
    console.error("A migration that sorts below a shipped one runs LAST on every database that");
    console.error("already migrated past it, so its data statements apply out of order — or twice.");
    console.error("Give the new migration the next unused number (" + nextFree + "), with no letter");
    console.error("suffix and no gap. A repair that genuinely must sort lower adds its filename to");
    console.error("GRANDFATHERED_FILES in this gate, in the same merge request.");
  }
  // gaps[0] is the first free number only when the rejected file is what opened the gap. A number claimed and released while files above it shipped — which is how 0002 and 0078 exist — is retired, and filling it would go dense, silence every branch, and pass a migration that runs last on every migrated database. Never print the one line without the other.
  if (gaps.length > 0) {
    console.error("If " + nextFree + " was claimed and released, or held a migration that shipped and was removed, it is retired:");
    console.error("add it to RETIRED_NUMBERS instead of reusing it, and keep the new migration at " + pad(max + 1) + ".");
  }
  if (stale.length > 0) {
    console.error("A grandfather entry that names no file whitelists that filename forever — delete the entry.");
  }
  process.exit(1);
}

console.log("no-backfilled-migration gate: OK (" + files.length + " migrations, max " + pad(max) + ") in " + dir);
'
