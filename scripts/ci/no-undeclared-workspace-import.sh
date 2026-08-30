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
# Overridable so no-undeclared-workspace-import.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Workspaces that legitimately ship no src/: e2e is specs only, and packages/config ships shared vitest/tsconfig presets at its root. Anything else with an empty src/ is a find-path regression, not a package to skip.
const NO_SRC = new Set(["e2e", "packages/config"]);

// Expand the root `workspaces` globs. Only the trailing-/* and literal forms the
// repo actually uses are handled; a richer pattern is a config change that must
// come with a change here rather than be silently half-matched.
//
// One anchor per glob, because the expansion is where a workspace goes missing from this guard entirely rather than merely unscanned: a renamed packages/ used to be skipped in silence, leaving apps/* alone to satisfy every floor below while every package edge went unchecked. Each anchor is a workspace CLAUDE.md names as part of the layout, so it cannot move without the layout moving with it.
const GLOB_ANCHORS = new Map([
  ["apps/*", path.join("apps", "api")],
  ["packages/*", path.join("packages", "core")],
  ["packages/strategy/*", path.join("packages", "strategy", "trailing-trade")],
]);

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dirs = [];
const globRoots = [];
for (const pattern of rootPkg.workspaces ?? []) {
  if (!pattern.endsWith("/*")) {
    dirs.push(pattern);
    continue;
  }
  const anchor = GLOB_ANCHORS.get(pattern);
  // Refused rather than expanded blind: a glob nobody pinned an anchor for is a glob whose expansion cannot be shown to still reach anything.
  if (anchor === undefined) {
    console.error("workspaces glob " + pattern + " has no pinned anchor in this guard, so its expansion cannot be checked.");
    process.exit(1);
  }
  globRoots.push({ name: pattern.slice(0, -2), anchors: [anchor] });
}

for (const dir of collectOrExit({
  root,
  label: "workspace directories",
  entry: "dir",
  flat: true,
  test: () => true,
  roots: globRoots,
})) {
  dirs.push(path.relative(root, dir).split(path.sep).join("/"));
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

// The exemption is valid only while the path has no source tree. Refusing a stale entry makes newly added source visible instead of letting the early continue below turn NO_SRC into a permanent scan bypass.
const staleNoSrc = [...NO_SRC].filter((dir) => fs.existsSync(path.join(root, dir, "src")));
if (staleNoSrc.length > 0) {
  console.error("workspace packages listed in NO_SRC but now carrying src/:\n  " + staleNoSrc.join("\n  "));
  console.error("");
  console.error("Remove each package from NO_SRC and give its source walk an entry-point anchor.");
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

// One root per workspace src/, each anchored on the entry point that package declares for itself. The `unscanned` list below is already a per-package floor, but a floor only sees a src/ that yielded NOTHING; a package whose src/ merely narrowed — a feature tree moved, a nested workspace re-parented — still yields files, and its undeclared imports simply stop being reported while the scanned count stays healthy.
//
// The anchor is derived rather than hard-coded so a new package is covered with no edit here, and so the anchor is a file the package itself promises to ship: the entry every other workspace resolves it through cannot move without the manifest moving with it.
const ENTRY_OVERRIDES = new Map([
  // apps/web is a Vite app: its entry is named in index.html, so package.json declares none.
  ["apps/web", path.join("src", "main.tsx")],
]);

const entryOf = ({ dir, manifest }) => {
  const override = ENTRY_OVERRIDES.get(dir);
  if (override !== undefined) return override;
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  // A subpath-only package (packages/core, packages/notify) declares no root entry, so the first of its exported modules in sorted order stands in: it is still a file the package promises to ship, and sorting rather than taking insertion order keeps the anchor from moving when the exports map is reordered.
  const exported =
    pkg.exports === null || typeof pkg.exports !== "object"
      ? []
      : Object.values(pkg.exports).filter((v) => typeof v === "string" && v.startsWith("./src/")).sort();
  const entry = pkg.types ?? pkg.main ?? exported[0];
  return entry === undefined ? undefined : path.normalize(entry.replace(/^\.\//, ""));
};

const roots = [];
const noEntry = [];
for (const pkg of pkgs) {
  if (NO_SRC.has(pkg.dir)) continue;
  const entry = entryOf(pkg);
  // Refused rather than skipped: a package this guard cannot anchor is a package whose walk cannot be shown to still reach it, and silently dropping it is the fail-open the anchor exists to close.
  if (entry === undefined || !entry.startsWith("src" + path.sep)) {
    noEntry.push(pkg.dir);
    continue;
  }
  roots.push({ name: path.join(pkg.dir, "src"), anchors: [path.join(pkg.dir, entry)] });
}
if (noEntry.length > 0) {
  console.error("workspace packages with no src/ entry point for this guard to anchor on:\n  " + noEntry.join("\n  "));
  console.error("");
  console.error("Declare types, main, or exports[\".\"] pointing into src/, or list the package in NO_SRC if it ships no source.");
  process.exit(1);
}

const walked = collectOrExit({
  root,
  label: ".ts/.tsx files",
  test: (p) => /\.tsx?$/.test(p),
  roots,
});

// Regrouped by owning package, because the declared-dependency check is per manifest.
const filesByPkg = new Map();
for (const file of walked) {
  const rel = path.relative(root, file);
  const owner = roots.find((r) => rel.startsWith(r.name + path.sep));
  if (owner === undefined) continue;
  const dir = owner.name.slice(0, -("/src".length));
  if (!filesByPkg.has(dir)) filesByPkg.set(dir, []);
  filesByPkg.get(dir).push(file);
}

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

  const files = filesByPkg.get(dir) ?? [];
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
