#!/usr/bin/env bash
# Forbid bare `/* v8 ignore` directives. Every coverage-ignore comment
# must carry a trailing rationale on the same line so the reason for
# excluding the code is checked-in next to the directive — silent
# coverage holes are the failure mode this guards.
#
# Accepted shape:
#   /* v8 ignore next 3 -- reason: throws on impossible config branch */
#
# Rejected shape:
#   /* v8 ignore next 3 */
#   /* v8 ignore start */
#
# The rule is intentionally simple: any `/* v8 ignore` line that does NOT
# contain `--` (the rationale separator) fails the build.
#
# Exception: `/* v8 ignore stop */` is a block terminator. It carries no logic
# and no coverage decision of its own — the rationale lives on the matching
# `/* v8 ignore start -- reason: ... */`. Requiring a reason on `stop` is noise,
# so `stop` terminators are exempt.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it if no `v8 ignore` directive is seen at all (the
# codebase has commented ones), because a drift gate that passes vacuously is
# worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-uncommented-coverage-ignore

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-uncommented-coverage-ignore.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// A v8 ignore directive on one line. STOP is the exempt block terminator.
const DIRECTIVE = /\/\*+\s*v8\s+ignore[^*]*\*\//;
const STOP = /\/\*+\s*v8\s+ignore\s+stop\s*\*\//;

// Walked and vacuity-checked PER ROOT by the shared helper. The directive count below is a second floor, but it is a UNION count: apps/ going dark still leaves every directive under packages/ to keep it healthy, so it cannot see half a walk. The per-root anchors can.
//
// One apps anchor is .tsx on purpose. The extension clause covers .tsx, and with .ts anchors only, dropping it would leave both floors and both anchors satisfied while every directive in apps/web went unscanned.
const files = collectOrExit({
  root,
  label: "source files",
  skipDirs: ["node_modules", "dist"],
  test: (p) => /\.(tsx?|m?js)$/.test(p),
  roots: [
    {
      name: "apps",
      anchors: [path.join("apps", "api", "src", "index.ts"), path.join("apps", "web", "src", "main.tsx")],
    },
    { name: "packages", anchors: [path.join("packages", "contracts", "src", "decimal.ts")] },
  ],
});

let directives = 0;
const bad = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DIRECTIVE.test(line)) continue;
    directives++; // any v8 ignore directive, commented or not — proves the scan works
    if (line.includes("--") || STOP.test(line)) continue;
    bad.push(path.relative(root, file) + ":" + (i + 1) + ": " + line.trim());
  }
}

// The codebase carries commented v8-ignore directives, so zero directives seen
// means the scan or regex regressed — fail, do not pass vacuously.
if (directives === 0) {
  console.error("no v8 ignore directives resolved across apps/ or packages/ — scan regression in this gate.");
  process.exit(1);
}

if (bad.length > 0) {
  console.error("Uncommented /* v8 ignore */ directives found:");
  console.error(bad.map((b) => "  " + b).join("\n"));
  console.error("");
  console.error("Every /* v8 ignore */ directive must be followed by `-- reason: ...` on the same line.");
  console.error("See CLAUDE.md \"Anti-patterns to refuse\" — silent coverage holes are forbidden.");
  process.exit(1);
}

console.log("no-uncommented-coverage-ignore gate: OK (" + files.length + " files, " + directives + " directives checked)");
'
