#!/usr/bin/env bash
set -euo pipefail
# Guard: every packages/strategy/* workspace must have a real `test` task in
# turbo's graph. A workspaces-glob negation once hid them from turbo entirely,
# so strategy unit tests silently never ran in CI (#320). We assert the `test`
# task's command is not turbo's "<NONEXISTENT>" placeholder, so a deleted or
# renamed `test` script is caught too, not just a package dropped from the
# graph — a green pipeline with untested strategy code is the worst failure
# mode here.
#
# Runs in the bun:alpine CI image, which has neither git nor jq, so the root is
# derived from this script's location and JSON is parsed with node.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start turbo-sees-strategy

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root" # turbo resolves its workspace graph from the cwd

GUARD_ROOT="$root" bunx turbo run test --dry=json | GUARD_ROOT="$root" node -e '
const fs = require("node:fs");
const path = require("node:path");
const stratDir = path.join(process.env.GUARD_ROOT, "packages", "strategy");
const expected = new Set();
for (const d of fs.readdirSync(stratDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const pj = path.join(stratDir, d.name, "package.json");
  if (!fs.existsSync(pj)) continue;
  const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
  if (name) expected.add(name);
}
if (expected.size === 0) {
  console.error("no packages/strategy/* workspaces found — find path regression in this guard.");
  process.exit(1);
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  const seen = new Set(
    JSON.parse(buf).tasks
      .filter((t) => t.task === "test" && t.command !== "<NONEXISTENT>")
      .map((t) => t.package),
  );
  const missing = [...expected].filter((p) => !seen.has(p)).sort();
  if (missing.length > 0) {
    console.error("strategy packages with no runnable `test` task under turbo:\n" + missing.join("\n"));
    console.error("cause: a workspaces-glob regression dropped them, or a `test` script was removed/renamed — see #320.");
    process.exit(1);
  }
  console.log("all strategy packages have a runnable turbo test task:\n" + [...expected].sort().join("\n"));
});
'
