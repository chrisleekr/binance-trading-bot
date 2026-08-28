#!/usr/bin/env bash
# Forbid the hyphenated display form "Trailing-trade" in the docs.
#
# The strategy's display name is "Trailing Trade" (its `displayName`), while
# `trailing-trade` (lowercase) is the code slug/package id and stays hyphenated.
# The capitalised hyphenated form "Trailing-trade" is always a display-name
# regression, so this gate fails on it. Lowercase `trailing-trade` is left alone
# (it is the real identifier in fixtures, package paths, and backticked slugs).
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R/--include, so the
# scan uses bun's fs, not a recursive grep. A vacuity guard fails the gate if no
# docs are scanned, because a drift gate that passes vacuously is worse than none.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-hyphenated-trailing-trade

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-hyphenated-trailing-trade.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Walked and vacuity-checked by the shared helper: it refuses a walk that returns nothing AND one that still returns pages but no longer reaches docs/index.md, which names the strategy in its display form. The second stop is the one a page count cannot express — a docs re-layout leaves plenty of markdown in scope while the pages that actually name the strategy go unscanned.
const files = collectOrExit({
  root,
  label: "markdown files",
  skipDirs: ["node_modules"],
  test: (p) => p.endsWith(".md"),
  roots: [{ name: "docs", anchors: [path.join("docs", "index.md")] }],
});

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/Trailing-[Tt]rade/.test(lines[i])) {
      hits.push(path.relative(root, file) + ":" + (i + 1) + ": " + lines[i].trim());
    }
  }
}

if (hits.length > 0) {
  console.error("Hyphenated display name \"Trailing-trade\"/\"Trailing-Trade\" found (use \"Trailing Trade\"):");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("The strategy displayName is \"Trailing Trade\"; only the lowercase code slug");
  console.error("\"trailing-trade\" (package id, fixtures, backticked identifiers) keeps the hyphen.");
  process.exit(1);
}

console.log("no-hyphenated-trailing-trade gate: OK (" + files.length + " docs scanned)");
'
