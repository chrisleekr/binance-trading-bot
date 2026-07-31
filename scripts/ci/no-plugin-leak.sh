#!/usr/bin/env bash
# Plugin-leak gate (CLAUDE.md invariant #1). apps/api and apps/worker consume
# strategies/notifiers only through the registry surfaces: @app/strategy-core
# (contract + registry) and @app/notify (buildNotifyRegistry). A direct import
# of a concrete strategy plugin (@app/strategy-<name> other than the -core
# contract and the -backtest engine, both non-plugin infrastructure) or an
# @app/notify/providers/* module bypasses the registry and is a leak.
#
# Exemptions mirror the former ESLint rule: apps/web (typed UI consumer, not on
# the worker dispatch path), the registry bootstrap files (strategies.ts /
# notifiers.ts), and __tests__ (exercise plugins directly by design).
#
# Replaces the local/no-plugin-leak ESLint rule (eslint→oxlint migration, #576):
# oxlint's built-in no-restricted-imports can't express "ban @app/strategy-*
# except -core/-backtest" extensibly, so the invariant lives here as a scan gate
# (same family as no-locks.sh) and stays extensible — a new strategy package is
# covered with no rule edit.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it when the scan resolves zero plugin imports at all
# (the registry bootstrap files always import a plugin), because a drift gate
# that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-plugin-leak

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Whole app trees, not just src/: a leak in a root-level app file (e.g. a
// *.config.ts) is still a leak. __tests__/dist/node_modules are excluded.
const ROOTS = ["apps/api", "apps/worker"];
const SKIP_DIR = new Set(["node_modules", "dist", "__tests__"]);
// Registry bootstrap files import plugins by design (invariant #1 exemption).
const EXEMPT = new Set(["strategies.ts", "strategies.js", "notifiers.ts", "notifiers.js"]);

const tsFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) tsFiles(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};

const files = ROOTS.flatMap((r) => tsFiles(path.join(root, r)));

// A plugin specifier in import position, adjacent to the import keyword: static
// from "...", dynamic import("..."), or bindingless side-effect import "...".
// Q is a quote char class built from escapes so no literal apostrophe appears
// inside the bash single-quoted bun -e argument. The single adjacency match
// mirrors the four adjacent grep -e patterns the former GNU-grep version used,
// so an import keyword and an unrelated plugin string elsewhere on the same
// line do not falsely match.
const Q = "[\"\\u0027]";
const LEAK = new RegExp(
  "(?:\\bfrom|\\bimport\\s*\\(|^\\s*import)\\s*" + Q +
  "(@app/(?:strategy-|notify/providers/)[^\"\\u0027]*)" + Q,
);
// -core (contract) and -backtest (offline engine) are non-plugin infrastructure.
const isInfra = (spec) =>
  spec === "@app/strategy-core" || spec.startsWith("@app/strategy-core/") ||
  spec === "@app/strategy-backtest" || spec.startsWith("@app/strategy-backtest/");

let rawHits = 0;
const leaks = [];
for (const file of files) {
  const exempt = EXEMPT.has(path.basename(file));
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LEAK);
    if (!m) continue;
    rawHits++; // any plugin import in import position, incl. infra/exempt — proves the scan works
    if (exempt || isInfra(m[1])) continue;
    leaks.push(path.relative(root, file) + ":" + (i + 1) + " " + m[1]);
  }
}

// The registry bootstrap files always import a concrete plugin, so zero raw hits
// means the scan or specifier regex regressed — fail, do not pass vacuously.
if (rawHits === 0) {
  console.error("no plugin imports resolved across apps/{api,worker} — scan regression in this gate.");
  process.exit(1);
}

if (leaks.length > 0) {
  console.error("Plugin leak(s):");
  console.error(leaks.map((l) => "  " + l).join("\n"));
  console.error("");
  console.error("apps/{api,worker} must not import strategy/notifier plugins directly.");
  console.error("Use the @app/strategy-core registry / @app/notify buildNotifyRegistry (CLAUDE.md invariant #1).");
  process.exit(1);
}

console.log("no-plugin-leak gate: OK (" + files.length + " files, " + rawHits + " plugin imports checked)");
'
