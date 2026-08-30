#!/usr/bin/env bash
set -euo pipefail
# Reviewed-inventory gate for `.toFixed(` and fixed-two `maximumFractionDigits` sites under all of apps/web/src.
#
# Fixed precision is correct for values such as percentages, byte sizes, durations, ratios, and CSS widths, but it can erase a real sub-cent quote amount. Every occurrence is registered with its pattern identity and a factual reason so review distinguishes deliberate rounding from money loss.
#
# The pin is `relative path -> { reason, sites: ["pattern-id: normalised matched line"] }`, compared as a sorted multiset without line numbers so unrelated movement does not churn it.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-unreviewed-tofixed

repo_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$repo_root}"
cd "$repo_root"

CI_WALK_LIB="$repo_root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.GUARD_ROOT;
const SCAN_DIR = path.join("apps", "web", "src");
const INVENTORY = path.join("scripts", "ci", "tofixed-inventory.json");
const SOURCE_EXT = new Set([".ts", ".tsx"]);
const PATTERNS = [
  { id: "to-fixed", matches: (line) => line.includes(".toFixed(") },
  {
    id: "fixed-two",
    matches: (line) => /\bmaximumFractionDigits(?:["\x27])?\s*:\s*2\b/.test(line),
  },
];
const SITE_IDENTITY = /^(?:to-fixed|fixed-two): /;

// Walked and vacuity-checked by the shared helper. The empty-walk floor this gate already carried catches a scan directory that vanished; what it could not catch is a walk that still returns hundreds of components while the feature trees where money is actually rendered have moved out of scope, which is indistinguishable from every site being registered.
//
// The anchor is the app entry point: permanent, and .tsx, so a walk that stopped collecting .tsx — which is nearly every file this gate cares about — is reported rather than counted.
//
// Sorted by path so the reported problems keep a stable order; the walk itself makes no ordering promise.
const sourceFiles = collectOrExit({
  root,
  label: ".ts/.tsx files",
  test: (p) => SOURCE_EXT.has(path.extname(p)),
  roots: [{ name: SCAN_DIR, anchors: [path.join(SCAN_DIR, "main.tsx")] }],
}).sort((a, b) => a.localeCompare(b));

// Collapse whitespace so re-indenting a matched line is not an inventory change.
const normalise = (line) => line.trim().replace(/\s+/g, " ");

const actual = new Map();
for (const file of sourceFiles) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const sites = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    for (const pattern of PATTERNS) {
      if (pattern.matches(line)) sites.push(`${pattern.id}: ${normalise(line)}`);
    }
  }
  if (sites.length > 0) actual.set(rel, sites.sort());
}

const inventoryPath = path.join(root, INVENTORY);
if (!fs.existsSync(inventoryPath)) {
  console.error(`no-unreviewed-tofixed: missing inventory at ${INVENTORY}.`);
  process.exit(1);
}
let inventory;
try {
  inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
} catch (err) {
  console.error(`no-unreviewed-tofixed: ${INVENTORY} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const problems = [];
for (const [rel, sites] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = inventory[rel];
  if (!entry) {
    problems.push(
      `unregistered file: ${rel}\n` +
        sites.map((s) => `    added site: ${s}`).join("\n") +
        `\n    Register it in ${INVENTORY} with a reason naming what kind of value this is (percent / bytes / duration / base-asset quantity / ratio / CSS width / 8dp computation), or switch it to a shared money formatter.`,
    );
    continue;
  }
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    problems.push(`missing reason: ${rel} is registered without one.`);
  }
  const registered = [...(entry.sites ?? [])].map(normalise).sort();
  const unidentified = registered.filter((site) => !SITE_IDENTITY.test(site));
  if (unidentified.length > 0) {
    problems.push(
      `missing pattern identity: ${rel}\n` +
        unidentified.map((site) => `    site: ${site}`).join("\n"),
    );
  }
  const remaining = [...registered];
  const added = [];
  for (const site of sites) {
    const at = remaining.indexOf(site);
    if (at === -1) added.push(site);
    else remaining.splice(at, 1);
  }
  if (added.length > 0 || remaining.length > 0) {
    problems.push(
      `pin drift: ${rel}\n` +
        [
          ...added.map((s) => `    added site: ${s}`),
          ...remaining.map((s) => `    vanished site: ${s}`),
        ].join("\n"),
    );
  }
}

for (const rel of Object.keys(inventory).sort()) {
  if (actual.has(rel)) continue;
  const sites = [...(inventory[rel].sites ?? [])].map(normalise);
  problems.push(
    `stale entry: ${rel} has no reviewed precision occurrence left, so its pin now protects nothing and would hide the next one added.\n` +
      sites.map((s) => `    vanished site: ${s}`).join("\n"),
  );
}

if (problems.length > 0) {
  console.error("no-unreviewed-tofixed: the reviewed inventory no longer matches the tree.\n");
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

const siteCount = [...actual.values()].reduce((n, s) => n + s.length, 0);
console.log(
  `no-unreviewed-tofixed gate: OK (${sourceFiles.length} files scanned, ${siteCount} reviewed sites across ${actual.size} files; patterns: ${PATTERNS.map((pattern) => pattern.id).join(", ")})`,
);
'
