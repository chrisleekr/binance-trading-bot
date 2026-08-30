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
# Overridable so turbo-sees-strategy.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# The expected workspace set is resolved BEFORE turbo runs, in its own process. A broken walk is then reported as a broken walk rather than as turbo finding no tasks, and the self-test can drive both walk stops without paying for a dry run of the whole graph.
EXPECTED_PACKAGES="$(CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Directory entries at depth 1, vacuity-checked by the shared helper. The anchor is trailing-trade, the first strategy plugin and the one CLAUDE.md names as the source of truth for the contract: a listing that no longer reaches it is a listing this gate can draw no conclusion from, and the workspace count alone cannot say so.
const dirs = collectOrExit({
  root,
  label: "strategy workspaces",
  entry: "dir",
  flat: true,
  test: (p) => fs.existsSync(path.join(p, "package.json")),
  roots: [
    {
      name: path.join("packages", "strategy"),
      anchors: [path.join("packages", "strategy", "trailing-trade")],
    },
  ],
});

const names = dirs
  .map((d) => JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name)
  .filter(Boolean);
if (names.length === 0) {
  console.error("no packages/strategy/* workspace declares a name — manifest parser regression in this guard.");
  process.exit(1);
}
console.log(names.join("\n"));
')"

bunx turbo run test --dry=json | EXPECTED_PACKAGES="$EXPECTED_PACKAGES" node -e '
const expected = new Set(process.env.EXPECTED_PACKAGES.split("\n").filter(Boolean));
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
