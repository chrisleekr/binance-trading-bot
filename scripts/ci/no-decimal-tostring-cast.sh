#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-decimal-tostring-cast

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
# Overridable so no-decimal-tostring-cast.selftest.sh can drive this exact
# script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# Guard: `x.toString() as DecimalString` mints the wire brand without the wire
# format. decimal.js switches `toString()` to exponential below 1e-6 and at or
# above 1e21, so a `0.00000036` commission leaves as `3.6e-7` and lands in a
# column of fixed-decimal numbers. The cast makes that invisible to the type
# system — the brand is the only thing a reviewer or `tsc` sees.
# `asDecimalString` routes the same value through `toFixed()`, which has no such
# threshold. `String(x) as DecimalString` is the same bypass spelled differently;
# it is matched with one level of call nesting, so `String(new Decimal(x))` is
# caught but a deeper nest is not — see docs/contributing/coding-rules.md.
#
# Runs under the bun:alpine CI image (BusyBox grep, no jq), so the scan uses
# bun's fs rather than a recursive grep.
CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Walked and vacuity-checked PER ROOT by the shared helper, which refuses a walk that returns nothing AND a walk that still returns files but no longer reaches a named module. The second stop is the one a count cannot express: a SKIP_DIRS entry that grew to match a real source directory still scans hundreds of files and prints a confident count over a subset that no longer contains the module this rule exists to protect.
//
// The apps anchor is `.tsx` on purpose. With `.ts` anchors only, reverting the `.tsx` clause in `test` leaves both floors and both anchors satisfied while the gate examines zero `.tsx` files, and every DecimalString cast in apps/web would be unpinned.
const files = collectOrExit({
  root,
  label: ".ts/.tsx files",
  skipDirs: ["node_modules", "dist", "coverage", ".turbo"],
  test: (p) => p.endsWith(".ts") || p.endsWith(".tsx"),
  roots: [
    { name: "apps", anchors: [path.join("apps", "web", "src", "main.tsx")] },
    { name: "packages", anchors: [path.join("packages", "contracts", "src", "decimal.ts")] },
  ],
});

// Comments are prose (this rule is stated verbatim in packages/contracts/src/decimal.ts) and must not be reported as hard violations.
//
// Blanked in place rather than deleted: dropping the newlines inside a block comment shifts every later line number, and the first real violation this gate found sat directly under a JSDoc block.
//
// Anchored to line start, which is the difference between blanking a comment and blanking code. An UNCLOSED `/*` inside a string literal — `const u = "https://example.com/*"` — otherwise swallows everything up to the next `*/` anywhere in the file, taking any violation in between with it, and the gate exits 0. (A glob like "src/**/*.ts" is harmless: it self-closes at `/**/`.) Every JSDoc and prose block in this repo starts its own line; a string literal never does.
const blankKeepingLines = (s) => s.replace(/[^\n]/g, " ");
const stripComments = (s) =>
  s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blankKeepingLines)
    .replace(/^\s*\/\/.*$/gm, blankKeepingLines);

// Matched across whitespace, so a prettier reflow that puts `as DecimalString` on its own line does not slip past.
const CASTS = [
  /\.toString\(\)\s*as\s+DecimalString\b/g,
  // `String(` only when it is the global, not the tail of `.toString(` or of a longer identifier. A lookbehind rather than a leading group: it consumes nothing, so `m.index` points at `String` and the reported line is right even when the call starts at column 0.
  /(?<![.\w$])String\((?:[^()]|\([^()]*\))*\)\s*as\s+DecimalString\b/g,
];

const violations = [];
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const code = stripComments(raw);
  const rawLines = raw.split("\n");
  const seen = new Set();
  for (const re of CASTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      // The line the cast STARTS on, so a prettier-wrapped cast is reported where the value is built rather than where the annotation landed.
      seen.add(code.slice(0, m.index).split("\n").length);
    }
  }
  for (const line of [...seen].sort((a, b) => a - b)) {
    violations.push(
      path.relative(root, file) + ":" + line + "  " + (rawLines[line - 1] ?? "").trim(),
    );
  }
}

if (violations.length > 0) {
  console.error("DecimalString brand minted without the wire format:");
  console.error(violations.map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Use asDecimalString(x) from @app/contracts — it formats via toFixed(), which never emits exponential notation.");
  process.exit(1);
}

console.log("no toString()/String() DecimalString casts (" + files.length + " files scanned).");
'
