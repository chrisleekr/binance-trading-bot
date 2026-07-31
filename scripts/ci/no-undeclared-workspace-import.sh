#!/usr/bin/env bash
set -euo pipefail
# Guard: a workspace package may only import an `@app/*` sibling it declares in
# its own package.json (dependencies / devDependencies / peerDependencies).
#
# An undeclared import resolves today only because bun hoists every workspace
# package into the root node_modules. That is incidental, not a guarantee: an
# isolated install, a node_modules-linker change, or any install that does not
# hoist turns a missing declaration into an unresolvable module. Declaring the
# edge makes resolution independent of install layout, and keeps the bun/turbo
# dependency graph honest — turbo schedules and caches on declared edges, so an
# undeclared one is invisible to it.
#
# The package list comes from the root `workspaces` field, not hardcoded globs,
# so a workspaces change cannot silently shrink coverage. Three vacuity guards
# fail the gate rather than pass it: zero packages discovered, a package whose
# src/ yields no files, and a scan that resolves no declared edge (which is what
# a broken specifier regex looks like). A drift gate that passes vacuously is
# worse than no gate at all.
#
# Runs in the bun:alpine CI image, which has neither git nor jq — and no real
# node either, only bun's fallback shim — so the root is derived from this
# script's location and JSON is parsed with bun.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-undeclared-workspace-import

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Workspaces that legitimately ship no src/: e2e is specs only, packages/config
// ships shared vitest/tsconfig presets at its root. Anything else with an empty
// src/ is a find-path regression, not a package to skip.
const NO_SRC = new Set(["e2e", "packages/config"]);

// Expand the root `workspaces` globs. Only the trailing-/* and literal forms the
// repo actually uses are handled; a richer pattern is a config change that must
// come with a change here rather than be silently half-matched.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dirs = [];
for (const pattern of rootPkg.workspaces ?? []) {
  if (!pattern.endsWith("/*")) {
    dirs.push(pattern);
    continue;
  }
  const prefix = pattern.slice(0, -2);
  const parent = path.join(root, prefix);
  if (!fs.existsSync(parent)) continue;
  for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(path.posix.join(prefix, e.name));
  }
}

// A glob parent such as packages/* also yields group dirs (packages/strategy),
// which carry no manifest of their own.
const pkgs = dirs
  .map((dir) => ({ dir, manifest: path.join(root, dir, "package.json") }))
  .filter((p) => fs.existsSync(p.manifest));

if (pkgs.length === 0) {
  console.error("no workspace packages found — find-path regression in this guard.");
  process.exit(1);
}

// Static / dynamic / side-effect ESM specifiers, normalised to the base package
// (@app/core/env -> @app/core). `from` also covers re-exports. The repo is
// ESM-only, so require() is not scanned. Tests live in <pkg>/__tests__/ and are
// out of scope by construction: only src/ ships.
const SPEC = /(?:from\s*|import\s*\(\s*|import\s+)["'"'"'](@app\/[^"'"'"']+)["'"'"']/g;

// Comments are stripped first: a doc comment illustrating an import of another
// package would otherwise be reported as a hard violation.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const srcFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

const violations = new Set();
const unscanned = [];
let scanned = 0;
let declaredEdges = 0;

for (const { dir, manifest } of pkgs) {
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  const files = srcFiles(path.join(root, dir, "src"));
  if (files.length === 0 && !NO_SRC.has(dir)) unscanned.push(dir);

  for (const file of files) {
    scanned++;
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const [, spec] of src.matchAll(SPEC)) {
      const base = spec.split("/").slice(0, 2).join("/");
      if (base === pkg.name || declared.has(base)) {
        declaredEdges++;
        continue;
      }
      violations.add(dir + " -> " + base + " (not in " + dir + "/package.json)");
    }
  }
}

if (unscanned.length > 0) {
  console.error("packages whose src/ yielded no files — find-path regression in this guard:\n  " + unscanned.join("\n  "));
  process.exit(1);
}

// A regex that stopped matching still sees thousands of files; only a resolved
// declared edge proves the scanner actually works.
if (scanned === 0 || declaredEdges === 0) {
  console.error("scanned " + scanned + " files, resolved " + declaredEdges + " declared @app/* edges — regex regression in this guard.");
  process.exit(1);
}

if (violations.size > 0) {
  console.error("Undeclared workspace imports:\n" + [...violations].sort().map((v) => "  " + v).join("\n"));
  console.error("");
  console.error("Every @app/* package imported from a workspace package must be declared in");
  console.error("that package.json. Undeclared imports resolve only via bun root-hoisting and");
  console.error("break under an install that does not hoist. Add the workspace:* dependency.");
  process.exit(1);
}

console.log("no undeclared @app/* workspace imports (" + pkgs.length + " packages, " + scanned + " files, " + declaredEdges + " declared edges)");
'
