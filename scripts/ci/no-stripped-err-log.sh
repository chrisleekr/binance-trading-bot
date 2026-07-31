#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stripped-err-log

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

# Guard: a log payload's `err` key must carry the raw caught binding, not a
# stringified value. pino's `err` serializer only fires on an Error object; a
# pre-stringified `.message` / `instanceof`-ternary / `String(...)` discards the
# stack. Adding one back silently loses stack traces at that log site again.
#
# Runs under the bun:alpine CI image (BusyBox grep, no jq), so the scan uses
# bun's fs rather than a recursive grep, mirroring no-undeclared-workspace-import.
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

// packages/strategy + packages/indicators are pure (no pino logger by invariant),
// so an `err:` object key there is a Result value field, never a log key — the
// strategy `Result` type uses `{ ok, err }`. Scoping them out keeps the
// helper-call patterns from false-flagging that value field.
const pureRoots = [
  path.join(root, "packages", "strategy") + path.sep,
  path.join(root, "packages", "indicators") + path.sep,
];
const isPure = (f) => pureRoots.some((p) => f.startsWith(p));
const files = [
  ...tsFiles(path.join(root, "apps")),
  ...tsFiles(path.join(root, "packages")),
].filter((f) => !isPure(f));

// The repo ships plenty of .ts under apps/ + packages/; zero files means the
// walk regressed, not that the invariant holds. A gate that passes vacuously is
// worse than no gate.
if (files.length === 0) {
  console.error("scan matched no .ts files — walk likely broken.");
  process.exit(1);
}

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
