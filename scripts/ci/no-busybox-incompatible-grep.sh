#!/usr/bin/env bash
# Meta-guard: no CI gate may depend on GNU/BSD-only grep options that the CI
# image's BusyBox grep silently rejects.
#
# The lint job runs under oven/bun:*-alpine, whose BusyBox grep does not
# implement the long options --include / --exclude / --exclude-dir. Given one,
# BusyBox grep prints "grep: unrecognized option" to stderr and matches
# nothing; a gate that
# pipes or command-substitutes that grep swallows the error and passes
# vacuously — the invariant it guards is then unenforced in CI (#645, where all
# six grep-based gates were silently dead). This guard fails the build if any
# scripts/ci/*.sh reintroduces those flags in a grep command, so a scan gate
# must instead walk the tree with bun's fs (see no-undeclared-workspace-import.sh
# and the six gates ported in #645).
#
# Scope: the --include / --exclude / --exclude-dir file-filter long options only.
# BusyBox v1.37 grep DOES support -R/-r (verified), so recursive grep is not
# flagged; the vacuity bug is specifically these unsupported long options.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-busybox-incompatible-grep

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const dir = path.join(root, "scripts/ci");
const self = "no-busybox-incompatible-grep.sh"; // names the flags in its own text
const scripts = fs.readdirSync(dir).filter((f) => f.endsWith(".sh") && f !== self);
if (scripts.length === 0) {
  console.error("no scripts/ci/*.sh files scanned — scan-path regression in this guard.");
  process.exit(1);
}

const BAD = /--include\b|--exclude(-dir)?\b/;
const hits = [];
for (const f of scripts) {
  const lines = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // full-line comments may document the flags
    if (BAD.test(line)) hits.push("scripts/ci/" + f + ":" + (i + 1) + ": " + line.trim());
  }
}

if (hits.length > 0) {
  console.error("BusyBox-incompatible grep option(s) in a CI gate:");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("--include / --exclude / --exclude-dir are rejected by the CI image BusyBox grep and make the");
  console.error("gate pass vacuously. Walk the tree with bun fs instead (see #645, and");
  console.error("no-undeclared-workspace-import.sh for the pattern).");
  process.exit(1);
}

console.log("no-busybox-incompatible-grep gate: OK (" + scripts.length + " CI scripts scanned)");
'
