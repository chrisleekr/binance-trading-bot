#!/usr/bin/env bash
set -euo pipefail

# Guard: every type-level assertion file (`__tests__/**/*.test-d.ts`) must be
# wired into a `tsc` invocation that actually compiles it, and every
# `@ts-expect-error` directive inside it must suppress a real type error.
#
# A `.test-d.ts` file encodes `@ts-expect-error` negative assertions; those
# only bite if some tsc pass includes the file AND the directive falls on the
# line directly above the error. The default per-package `tsconfig.json`
# excludes `__tests__` (or scopes `include` to `src/`), so a guard added
# without extra wiring is silently dead.
#
# Gate 1 — wiring: each guard file's owning package must have a
# `tsconfig.test-d.json` whose `include` covers `__tests__/**/*.test-d.ts`,
# and a `typecheck` script that runs `tsc -p tsconfig.test-d.json`.
#
# Gate 2 — liveness: for each owning package, compile its
# `tsconfig.test-d.json` and fail on TS2578 ("Unused '@ts-expect-error'
# directive"). An unconsumed directive means the guard asserts nothing.
# The typecheck lane also surfaces TS2578 (gate 1 forces the invocation into
# the typecheck script), so this repeats that signal in the lint lane to name
# the usual cause — a directive above a multi-line call, where tsc reports at
# the argument's own line — which the bare compiler error does not.
#
# Vacuity guard: the repo has guard files today, so zero matches means the scan
# operation regressed. An empty scan fails rather than passing vacuously.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks GNU flags and which
# has no jq, so the scan and JSON parsing use bun's fs (the same portable
# approach as no-undeclared-workspace-import.sh), not a recursive grep.
#
# Compiling needs no prior `turbo build`: every workspace package resolves via
# `"types": "src/index.ts"`, so the lint lane (which runs no build) is enough.

# Setup
source "$(dirname "$0")/_common.sh"
ci::start no-unwired-test-d

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const COVER = "__tests__/**/*.test-d.ts";

const readJson = (p) => {
  const raw = fs.readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(raw);
};

const guardFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      guardFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".test-d.ts") && dir.split(path.sep).includes("__tests__")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
};

const owningPkgDir = (file) => {
  let dir = path.dirname(file);
  while (dir.length >= root.length) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
};

const files = [
  ...guardFiles(path.join(root, "apps")),
  ...guardFiles(path.join(root, "packages")),
];

if (files.length === 0) {
  console.error("scan matched nothing — glob likely broken. Expected at least one __tests__/**/print.test-d.ts.");
  process.exit(1);
}

// ---- Gate 1: wiring ----
const violations = [];
const tsconfigs = new Set();

for (const file of files) {
  const rel = path.relative(root, file);
  const pkgDir = owningPkgDir(file);
  if (!pkgDir) {
    violations.push(rel + ": no owning package.json found");
    continue;
  }
  const tsconfigPath = path.join(pkgDir, "tsconfig.test-d.json");
  if (!fs.existsSync(tsconfigPath)) {
    violations.push(rel + ": owning package lacks tsconfig.test-d.json");
    continue;
  }
  tsconfigs.add(tsconfigPath);

  const include = readJson(tsconfigPath).include ?? [];
  const covered = include.some((g) => g.includes("__tests__") && g.includes(".test-d.ts"));
  if (!covered) {
    violations.push(rel + ": tsconfig.test-d.json include does not cover " + COVER);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const typecheck = pkg.scripts?.typecheck ?? "";
  if (!typecheck.includes("tsconfig.test-d.json")) {
    violations.push(rel + ": typecheck script does not run tsc -p tsconfig.test-d.json");
  }
}

if (violations.length > 0) {
  console.error("Unenforced type-level guard files:");
  console.error(violations.map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Each __tests__/**/print.test-d.ts needs its package wired: a tsconfig.test-d.json");
  console.error("including " + COVER + ", and a typecheck script appending");
  console.error("`tsc -p tsconfig.test-d.json --noEmit`. See docs/contributing/coding-rules.md.");
  process.exit(1);
}

// ---- Gate 2: liveness (TS2578 — unused @ts-expect-error) ----
const tsc = path.join(root, "node_modules", ".bin", "tsc");
const failures = [];

for (const tc of tsconfigs) {
  const rel = path.relative(root, tc);
  try {
    execFileSync(tsc, ["-p", tc, "--noEmit"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    const combined = (err.stdout ?? "") + (err.stderr ?? "");
    const unused = combined.split("\n").filter((l) => l.includes("TS2578"));
    if (unused.length > 0) {
      failures.push(rel + ":\n" + unused.map((l) => "    " + l.trim()).join("\n"));
    } else {
      // Fail closed: a compile that breaks for any other reason leaves the
      // liveness question unanswered, so it must not pass silently.
      failures.push(rel + ": tsc failed (not TS2578) — broken guard?\n" +
        combined.trim().split("\n").slice(-8).map((l) => "    " + l).join("\n"));
    }
  }
}

if (failures.length > 0) {
  console.error("Unused @ts-expect-error directives in guard files:");
  console.error("");
  for (const f of failures) {
    console.error("  " + f);
  }
  console.error("");
  console.error("Every @ts-expect-error in a .test-d.ts file must suppress a real type error.");
  console.error("TS2578 means a directive exists on a line whose next line has no error.");
  console.error("Common cause: directive is above a multi-line call but the error reports at");
  console.error("an argument position. Move the directive to the exact error line.");
  process.exit(1);
}'

echo ""
echo "Guard files: all wired and every @ts-expect-error directive live."
