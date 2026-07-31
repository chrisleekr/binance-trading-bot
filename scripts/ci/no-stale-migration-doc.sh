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

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Two discredited full phrases. The .? before db:generate tolerates a backtick
// or other single leader before the token.
const PATTERN = /(no pending migrations after .?db:generate|drizzle-kit migrate apply)/;

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

const files = [];
const claudeMd = path.join(root, "CLAUDE.md");
if (fs.existsSync(claudeMd)) files.push(claudeMd);
mdFiles(path.join(root, "docs"), files);

if (files.length === 0) {
  console.error("no markdown files scanned (CLAUDE.md + docs/) — scan-path regression in this gate.");
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
