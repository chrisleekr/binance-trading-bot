#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-error-cast

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

# Guard: `(x as Error).message` throws when the caught value is not an Error
# (providers throw primitives, null, Binance error objects). errorMessage from
# @app/core/error narrows safely and single-sources the extraction. Every such
# cast must route through it instead.
#
# Runs under the bun:alpine CI image (BusyBox grep, no jq), so the scan uses
# bun's fs rather than a recursive grep.
GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const tsFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      tsFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".ts")) out.push(path.join(dir, e.name));
  }
  return out;
};

const files = [
  ...tsFiles(path.join(root, "apps")),
  ...tsFiles(path.join(root, "packages")),
];

// Zero files means the walk regressed, not that the invariant holds.
if (files.length === 0) {
  console.error("scan matched no .ts files — walk likely broken.");
  process.exit(1);
}

// Comments are prose and must not be reported as hard violations.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CAST = /\([A-Za-z_$][\w$]* as Error\)\.message/;

const violations = [];
for (const file of files) {
  const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
  lines.forEach((ln, i) => {
    if (CAST.test(ln)) {
      violations.push(path.relative(root, file) + ":" + (i + 1) + "  " + ln.trim());
    }
  });
}

if (violations.length > 0) {
  console.error("Unsafe (x as Error).message cast:");
  console.error(violations.map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Use errorMessage(x) from @app/core/error — it narrows unknown safely.");
  process.exit(1);
}

console.log("no (x as Error).message casts (" + files.length + " files scanned).");
'
