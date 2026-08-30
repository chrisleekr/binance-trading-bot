#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-error-cast

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-error-cast.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# Guard: `(x as Error).message` throws when the caught value is not an Error (providers throw primitives, null, Binance error objects). An `errorMessage` helper narrows safely and single-sources the extraction. Every such cast must route through it instead.
#
# Runs under the bun:alpine CI image (BusyBox grep, no jq), so the scan uses
# bun's fs rather than a recursive grep.
CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Walked and vacuity-checked PER ROOT by the shared helper, which refuses a walk that returns nothing AND a walk that still returns files but no longer reaches a named module. A union walk with one shared floor is fail-open in the direction that matters most: `apps` going dark (a rename, a re-layout, a skip-list entry that grew) still leaves hundreds of files from `packages`, so both a zero-file floor and a single anchor are satisfied while apps/api, apps/worker and apps/web are never examined and the gate prints a confident count.
//
// One of the apps anchors is `.tsx` on purpose. With `.ts` anchors only, reverting the `.tsx` clause in `test` leaves both floors and both anchors satisfied while the gate examines zero `.tsx` files, so the extension widening would be unpinned by exactly the wrong-collection failure this per-root check exists to catch.
const files = collectOrExit({
  root,
  label: ".ts/.tsx files",
  skipDirs: ["node_modules", "dist", "coverage", ".turbo"],
  test: (p) => p.endsWith(".ts") || p.endsWith(".tsx"),
  roots: [
    {
      name: "apps",
      anchors: [
        path.join("apps", "api", "src", "index.ts"),
        path.join("apps", "web", "src", "main.tsx"),
      ],
    },
    {
      name: "packages",
      anchors: [path.join("packages", "core", "src", "error", "error-message.ts")],
    },
  ],
});

// Comments are prose (this rule is stated verbatim in packages/core/src/error/error-message.ts) and must not be reported as hard violations.
//
// Blanked in place rather than deleted: dropping the newlines inside a block comment shifts every later line number, and a violation sitting directly under a JSDoc block is then reported above the code that is wrong.
//
// Anchored to line start, which is the difference between blanking a comment and blanking code. An UNCLOSED `/*` inside a string literal — `const u = "https://example.com/*"` — otherwise swallows everything up to the next `*/` anywhere in the file, taking any violation in between with it, and the gate exits 0. (A glob like "src/**/*.ts" is harmless: it self-closes at `/**/`.)
//
// The anchor leaves a residual in each direction, and neither is closable with a regex; a sound fix needs a real tokeniser that knows string, template and comment state.
//   Fail-open: a multi-line template literal whose continuation line begins with `/*` IS at line start, so its body is blanked as if it were a comment, and an unclosed opener there swallows real code below it. A fixture pins this so the gap is observed rather than assumed.
//   Fail-closed: a block comment that does not start its own line and spans lines is no longer stripped at all, so prose in its body can be reported as a violation. That direction is noisy, never silent, so it is the safe one to leave.
const blankKeepingLines = (s) => s.replace(/[^\n]/g, " ");
const stripComments = (s) =>
  s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blankKeepingLines)
    .replace(/^\s*\/\/.*$/gm, blankKeepingLines);

// Matched over the whole file rather than line by line, and across whitespace, so a prettier reflow that puts the operand or the `as Error` on its own line does not slip past. The operand stays a bare identifier, and NOT because the residual is test-only: of the three member-expression casts in the tree, apps/web/src/features/technicals/components/technicals-health-pill.tsx is production code (guarded by an `if (q.error)` over a TanStack `Error | null`, so a non-Error yields undefined rather than a throw) and the other two are tests. Widening therefore needs a decision on test-file exemption AND a fix for that read, not a longer regex.
const CAST = /\(\s*[A-Za-z_$][\w$]*\s+as\s+Error\s*\)\s*\.\s*message/g;

const violations = new Set();
for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const code = stripComments(raw);
  CAST.lastIndex = 0;
  let m;
  while ((m = CAST.exec(code)) !== null) {
    // The line the cast STARTS on, so a reflowed cast is reported where the value is read rather than where the `.message` landed.
    const line = code.slice(0, m.index).split("\n").length;
    // The matched text, whitespace-normalised, rather than the raw line: a reflowed cast starts on a line that does not contain the offence ("export const reflowed = ("), so printing the source line hands the reader context instead of evidence. A Set because two casts on one line otherwise report the same file:line and the same text twice.
    violations.add(path.relative(root, file) + ":" + line + "  " + m[0].replace(/\s+/g, " "));
  }
}

if (violations.size > 0) {
  console.error("Unsafe (x as Error).message cast:");
  console.error([...violations].map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Use errorMessage(x) — it narrows unknown safely. Import it from @app/core/error, or from @/shared/lib/api in apps/web, which does not depend on @app/core.");
  process.exit(1);
}

console.log("no (x as Error).message casts (" + files.length + " files scanned).");
'
