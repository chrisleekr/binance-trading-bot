#!/usr/bin/env bash
# Forbid discredited migration-workflow phrasing in the docs.
# CLAUDE.md "Quality gates" once claimed "no pending migrations after db:generate",
# but this repo hand-authors NNNN_*.sql migrations, so db:generate is not the
# source of truth and that gate is unsatisfiable. The db:migrate row likewise
# described "drizzle-kit migrate apply", which does not match the custom runner.
# This guard fails if either full phrase reappears in CLAUDE.md or docs/.
#
# Matches the full phrases only, never a bare db:generate or drizzle-kit: the
# corrected docs legitimately mention db:generate to say "do not use it" and
# mention drizzle-kit for db:check and typing.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it if no docs are scanned (scan-path regression),
# because a drift gate that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-migration-doc

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-stale-migration-doc.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Two discredited full phrases. The .? before db:generate tolerates a backtick
// or other single leader before the token.
const PATTERN = /(no pending migrations after .?db:generate|drizzle-kit migrate apply)/;

// Walked and vacuity-checked by the shared helper: it refuses a walk that returns nothing AND one that still returns pages but no longer reaches docs/index.md. The second stop is the one a page count cannot express — a docs re-layout leaves plenty of markdown in scope while the pages describing the migration workflow go unscanned.
const files = collectOrExit({
  root,
  label: "markdown files",
  skipDirs: ["node_modules"],
  test: (p) => p.endsWith(".md"),
  roots: [{ name: "docs", anchors: [path.join("docs", "index.md")] }],
});

// The charter is a fixed path rather than part of the walk, so it needs a refusal of its own. Pushing it only when it exists reads as a scan of two sources but degrades in silence to a scan of one: a rename leaves the docs walk healthy, the count unchanged, and the file that states the migration convention unread.
const claudeMd = path.join(root, "CLAUDE.md");
if (!fs.existsSync(claudeMd)) {
  console.error("CLAUDE.md not found — the charter is no longer scanned, and the docs count hides that.");
  process.exit(1);
}
files.push(claudeMd);

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) hits.push(path.relative(root, file) + ":" + (i + 1) + ": " + lines[i].trim());
  }
}

if (hits.length > 0) {
  console.error("Discredited migration-workflow phrasing found:");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("This repo hand-authors NNNN_*.sql migrations and runs a custom runner, so");
  console.error("db:generate is not the migration source of truth and \"drizzle-kit migrate");
  console.error("apply\" is wrong. Describe the hand-authored SQL convention instead. See");
  console.error("CLAUDE.md \"Quality gates\".");
  process.exit(1);
}

console.log("no-stale-migration-doc gate: OK (" + files.length + " docs scanned)");
'
