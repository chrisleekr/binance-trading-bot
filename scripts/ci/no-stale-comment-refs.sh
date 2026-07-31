#!/usr/bin/env bash
# Forbid stale plan/spec/issue/caller-list references in source comments.
# CLAUDE.md "Anti-patterns to refuse": comments must explain "why", not point
# at planning docs, issue numbers, or caller lists that rot when files move.
#
# Scans apps/** and packages/**/src/** for these patterns at line start (after
# whitespace and a // or * leader):
#   Spec:        Issue #         Phase NN
#   Refs:|Ref:   Used by         Called from         @see
# Test fixtures under __tests__/ may keep references where load-bearing;
# vendored (MIT indicator) code keeps its upstream @see refs.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it if no source files are scanned (scan-path
# regression), because a drift gate that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-comment-refs

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Line comments (//), block openers (/*, /**), and continuation lines inside a
// /** ... */ block (leading *), followed by a banned reference keyword.
const PATTERN = /^\s*(?:\/\/|\/\*+|\*)\s*(?:Spec:|Issue #|Phase [0-9]|Refs?:|Used by|Called from|@see)/;

const ROOTS = ["apps", "packages"];
const SKIP_DIR = new Set(["node_modules", "dist", "__tests__", "vendored"]);
const EXTS = /\.(tsx?|m?js)$/;

const srcFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) srcFiles(p, out);
    } else if (EXTS.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};

const files = ROOTS.flatMap((r) => srcFiles(path.join(root, r)));
if (files.length === 0) {
  console.error("no source files scanned under apps/ or packages/ — scan-path regression in this gate.");
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) hits.push(path.relative(root, file) + ":" + (i + 1) + ": " + lines[i].trim());
  }
}

if (hits.length > 0) {
  console.error("Banned stale reference comment(s) found:");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("Comments must capture the \"why\", not point at .claude/plans/*, issue numbers,");
  console.error("phase labels, or caller lists. See CLAUDE.md \"Anti-patterns to refuse\".");
  process.exit(1);
}

console.log("no-stale-comment-refs gate: OK (" + files.length + " files scanned)");
'
