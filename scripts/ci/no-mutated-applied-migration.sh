#!/usr/bin/env bash
# Forbid editing, renaming, or deleting a migration that has already been applied.
#
# `packages/db/src/migrate.ts` keys `_app_migrations` on the file NAME and stores the
# body's SHA-256. On the next boot it re-hashes each file and throws
# "already applied with a different checksum. Refusing to mutate history." — so a
# one-character edit to a shipped migration wedges every deployed database, and it
# wedges it at that file, before any LATER migration runs. There is no recovering
# in-band: the checksum map is read once, before the apply loop, so a repair
# migration can never execute.
#
# CI cannot catch this on its own, and that is the whole reason this gate exists.
# Every suite migrates a FRESH database, where a mutated file is indistinguishable
# from a correct one — the drift is only observable against a database that already
# holds the old checksum. This repo has been bitten twice: a renumber of an applied
# 0051 left an orphan ledger row, and a later comment-only edit of 0076/0079/0083
# stopped the deployed migrate job outright.
#
# The oracle is `migrations/checksums.json` rather than a diff against the base branch, for two reasons. The durable one: re-pinning a digest leaves a changed hex string in the diff, which a reviewer reads as "someone is rewriting history" — a merge-base diff leaves no artifact at all once it is satisfied. The mechanical one: both CI providers clone shallow here, so a merge-base would resolve to nothing on exactly the pipelines that matter. Do not "fix" that by adding fetch-depth 0; the first reason is the one that holds.
#
# The cost this pays, stated so it is not mistaken for a bug: a migration still being iterated on is re-pinned on every edit, because the manifest cannot tell "editing a file that shipped" from "editing a file that only exists on this branch". Adding a migration means adding its manifest line; changing an existing line is the deliberate, reviewable act of rewriting history, which is what this gate exists to make impossible to do by accident.
#
# Runs in the bun:alpine CI image, so the scan uses bun's fs rather than a
# recursive grep (BusyBox lacks -R / --include).
#
# `loadMigrations` and its digest are IMPORTED from migrate.ts, never re-implemented. A hand-copy would make "the manifest pins what the runner computes" a comment rather than a fact: change the algorithm or the file-selection rule there, and a copy here keeps passing while pinning digests nothing verifies against. migrate.ts has no top-level side effects, so importing it is safe. The same reasoning, and the same `await import`, is used by no-stale-config-table.selftest.sh.
#
# MIGRATIONS_DIR is overridable so the paired selftest can aim the gate at a fixture and prove it still fails on a mutation.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-mutated-applied-migration

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_DIR="${MIGRATIONS_DIR:-$root/packages/db/migrations}" \
GUARD_RUNNER="$root/packages/db/src/migrate.ts" \
bun -e '
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.GUARD_DIR;
const manifestPath = path.join(dir, "checksums.json");

// The runner itself, so the gate pins what production computes rather than what a copy of it computes.
const { loadMigrations } = await import(process.env.GUARD_RUNNER);

if (!fs.existsSync(dir)) {
  console.error("migrations directory not found: " + dir + " — scan-path regression in this gate.");
  process.exit(1);
}
if (!fs.existsSync(manifestPath)) {
  console.error("checksum manifest not found: " + manifestPath);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pinned = Object.keys(manifest);

// Selection rule and digest both come from the runner, so this cannot drift from what the ledger stores.
const migrations = await loadMigrations(dir);

// A gate that passes because it scanned nothing is worse than no gate.
if (migrations.length === 0 || pinned.length === 0) {
  console.error("scanned " + migrations.length + " migrations against " + pinned.length + " pinned entries — refusing to pass vacuously.");
  process.exit(1);
}

const mutated = [];
const unpinned = [];
const vanished = [];

for (const { name, checksum } of migrations) {
  const expected = manifest[name];
  if (expected === undefined) {
    unpinned.push(name);
    continue;
  }
  if (checksum !== expected) mutated.push(name + " (pinned " + expected.slice(0, 12) + ", now " + checksum.slice(0, 12) + ")");
}

const present = new Set(migrations.map((m) => m.name));
for (const name of pinned) if (!present.has(name)) vanished.push(name);

// One table rather than three hand-copied blocks: a fourth category is then a row, not a fourth if-block plus an updated sum guard. Each heading is asserted verbatim by the selftest, so the wording is load-bearing.
const problems = [
  [mutated, "Applied migrations were edited:"],
  [vanished, "Applied migrations were renamed or deleted:"],
  [unpinned, "New migrations are not pinned in the manifest:"],
].filter(([list]) => list.length > 0);

if (problems.length > 0) {
  for (const [list, heading] of problems) {
    console.error(heading);
    console.error(list.map((m) => "  " + m).join("\n"));
  }
  console.error("");
  console.error("A migration is immutable once it ships: every deployed database stores its");
  console.error("name and checksum, and the runner refuses to boot when either moves. Revert the");
  console.error("edit and put the change in a NEW migration. If you are adding one, add its line");
  console.error("to " + path.relative(process.cwd(), manifestPath) + " — the digest is");
  console.error("  shasum -a 256 " + path.relative(process.cwd(), dir) + "/<file>.sql");
  process.exit(1);
}

console.log("no-mutated-applied-migration gate: OK (" + migrations.length + " migrations pinned)");
'
