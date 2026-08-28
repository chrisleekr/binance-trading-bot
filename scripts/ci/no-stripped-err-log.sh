#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stripped-err-log

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-stripped-err-log.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# Guard: a log payload's `err` key must carry the raw caught binding, not a
# stringified value. pino's `err` serializer only fires on an Error object; a
# pre-stringified `.message` / `instanceof`-ternary / `String(...)` discards the
# stack. Adding one back silently loses stack traces at that log site again.
#
# Runs under the bun:alpine CI image (BusyBox grep, no jq), so the scan uses
# bun's fs rather than a recursive grep, mirroring no-undeclared-workspace-import.
CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// packages/strategy + packages/indicators are pure (no pino logger by invariant), so an `err:` object key there is a Result value field, never a log key — the strategy `Result` type uses `{ ok, err }`. Scoping them out keeps the helper-call patterns from false-flagging that value field.
//
// Excluded inside the walk rather than filtered after it, so the floors below are computed over the set actually scanned. A post-walk filter that swallowed a whole root would leave the floors reading a healthy pre-filter count.
const pureRoots = [
  path.join(root, "packages", "strategy") + path.sep,
  path.join(root, "packages", "indicators") + path.sep,
];
const isPure = (f) => pureRoots.some((p) => f.startsWith(p));

// Walked and vacuity-checked PER ROOT by the shared helper. A union walk with one shared floor is fail-open in the direction that matters: apps/ going dark still leaves the impure packages to keep the count healthy, while every logger call site in the three apps — which is where nearly all of them live — goes unread.
//
// The anchors are log-heavy modules that also survive the purity exclusion, so a narrowing of either root is reported rather than counted.
const files = collectOrExit({
  root,
  label: ".ts files",
  skipDirs: ["node_modules", "dist"],
  test: (p) => p.endsWith(".ts") && !isPure(p),
  roots: [
    {
      name: "apps",
      anchors: [path.join("apps", "api", "src", "index.ts"), path.join("apps", "worker", "src", "index.ts")],
    },
    { name: "packages", anchors: [path.join("packages", "binance", "src", "binance-rest.ts")] },
  ],
});

// Comments are prose: an explanatory comment illustrating the anti-pattern must
// not be reported as a hard violation.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A logger `err` key whose value is a stringified error rather than the raw
// binding: `.message` member access, an instanceof-Error ternary, String(...),
// or a message-stringifying helper call (`errorMessage(...)` / `errMsg(...)`).
const STRIPPED = [
  /\berr:\s*[A-Za-z_$][\w$.]*\.message\b/,
  /\berr:\s*[A-Za-z_$][\w$]*\s+instanceof\s+Error\s*\?/,
  /\berr:\s*String\s*\(/,
  /\berr:\s*errorMessage\s*\(/,
  /\berr:\s*errMsg\s*\(/,
];

const violations = [];
for (const file of files) {
  const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
  lines.forEach((ln, i) => {
    if (STRIPPED.some((re) => re.test(ln))) {
      violations.push(path.relative(root, file) + ":" + (i + 1) + "  " + ln.trim());
    }
  });
}

if (violations.length > 0) {
  console.error("Stripped error under a log `err` key (stack trace lost):");
  console.error(violations.map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Pass the raw caught binding: `logger.error({ err }, ...)`. pino serializes");
  console.error("the Error and keeps the stack. For operator-facing strings use errorMessage.");
  process.exit(1);
}

console.log("no stripped-error log keys (" + files.length + " files scanned).");
'
