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

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// A v8 ignore directive on one line. STOP is the exempt block terminator.
const DIRECTIVE = /\/\*+\s*v8\s+ignore[^*]*\*\//;
const STOP = /\/\*+\s*v8\s+ignore\s+stop\s*\*\//;

const ROOTS = ["apps", "packages"];
const SKIP_DIR = new Set(["node_modules", "dist"]);
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
