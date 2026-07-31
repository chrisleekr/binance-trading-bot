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

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const mdFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") mdFiles(p, out);
    } else if (/\.md$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};

const files = mdFiles(path.join(root, "docs"));
if (files.length === 0) {
  console.error("no markdown files scanned under docs/ — scan-path regression in this gate.");
  process.exit(1);
}

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
