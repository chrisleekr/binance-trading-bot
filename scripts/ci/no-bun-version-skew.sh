#!/usr/bin/env bash
# Forbid a Bun runtime version skew across the repo's nine pin sites.
#
# A partial bump validates CI on one Bun and ships another. Renovate reaches eight of the nine, but
# through five separate managers that can each be lost on their own: the two Bun customManagers, the
# built-in gitlabci manager for the bare `image: oven/bun:` line, the npm manager for `@types/bun`,
# and the asdf manager for `.tool-versions`. It never reaches `packageManager` — there Renovate
# resolves only node/yarn/npm/pnpm/vscode and skips every other name as `unknown-engines`.
#
# `@types/bun` is pinned exactly (no ~ or ^) because it describes the runtime's
# own API surface, and types from a different minor are a lie the compiler
# cannot catch.
#
# EXPECTED counts are exact, not floors: a site that stops matching drops the
# reading count and fails loudly rather than silently narrowing what is
# enforced. A count mismatch means "re-register the moved pin site".
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R and the long
# file-filter options, so the scan uses bun's fs rather than a recursive grep.
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-bun-version-skew

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$root}"
cd "$root"

GUARD_ROOT="$GUARD_ROOT" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const SEMVER = "[0-9]+\\.[0-9]+\\.[0-9]+";
// GitHub and GitLab both spell it `BUN_VERSION:`, GitLab quoting the value where GitHub does not.
const BUN_VERSION_KEY = "^[ \\t]*BUN_VERSION:[ \\t]*[\x27\"]?(" + SEMVER + ")[\x27\"]?[ \\t]*\\r?$";

// Line edges are [ \t], never \s: JS \s matches \n, so `^\s*` under the m flag can begin a match on a
// blank line above the pin and report that line instead. Each pattern spans a whole line so a
// commented-out pin cannot be counted as a live one.
// Every site that pins the Bun runtime, with the exact number of readings each
// file must yield. The counts are the vacuity guard: see the header.
const SITES = [
  { file: ".tool-versions", label: "asdf/mise pin", re: new RegExp("^bun[ \\t]+(" + SEMVER + ")[ \\t]*\\r?$", "gm"), expect: 1 },
  { file: ".github/workflows/ci.yml", label: "BUN_VERSION", re: new RegExp(BUN_VERSION_KEY, "gm"), expect: 1 },
  { file: ".github/workflows/nightly.yml", label: "BUN_VERSION", re: new RegExp(BUN_VERSION_KEY, "gm"), expect: 1 },
  { file: ".gitlab-ci.yml", label: "default job image", re: new RegExp("^[ \\t]*image:[ \\t]*oven/bun:(" + SEMVER + ")-alpine[ \\t]*\\r?$", "gm"), expect: 1 },
  { file: ".gitlab-ci.yml", label: "BUN_VERSION", re: new RegExp(BUN_VERSION_KEY, "gm"), expect: 2 },
  { file: "apps/server/Dockerfile", label: "ARG BUN_VERSION", re: new RegExp("^ARG BUN_VERSION=(" + SEMVER + ")[ \\t]*\\r?$", "gm"), expect: 1 },
];

// package.json is real JSON, so parse it instead of pattern-matching it — a
// regex here would quietly miss a reformatted field.
const PKG_FIELDS = 2; // packageManager + devDependencies["@types/bun"]

// Hand-counted on purpose, and the one number here that does not move when the registry does. Summing SITES for the expectation makes the gate validate the registry against itself: delete a row and the sum drops with it, so a gate reading five of six pin sites still reports OK over the sites that remain. The literal is compared against what was actually collected, so a pin that stops being read at all — a SITES row, or one of the package.json fields, which no count over SITES can see — is a mismatch rather than a smaller agreement. Adding or retiring a pin site means changing this number by hand, in the same diff as the registry.
const EXPECTED = 9; // 7 SITES readings + packageManager + @types/bun

const readings = [];
const problems = [];

const lineOf = (content, index) => content.slice(0, index).split("\n").length;
const errMsg = (err) => (err && err.message ? err.message : String(err));

// Detection is EXPECTED vs the collected count below; this branch exists for the remedy, and it is stated that way rather than sold as a second detector. Whenever a registry edit changes what is enforced, the count check fires too — but its message ("collected 8") reads as a pin that went missing from the repo, and a lowered `expect` over an unchanged file trips the per-site check instead, whose message tells the editor to re-register a site that never moved. Both send the reader to the wrong file. Naming the registry, before anything is read so it is never buried under a per-site complaint, is what points at the line that actually changed.
const declared = SITES.reduce((n, s) => n + s.expect, 0) + PKG_FIELDS;
if (declared !== EXPECTED) {
  problems.push(
    "the registry and package.json declare " + declared + " pin readings, but this gate expects " + EXPECTED +
    " — a row was added to or removed from the registry above, or the `expect` on a row that stayed was changed. If that was deliberate, update the hand-counted EXPECTED in the same diff; it is kept independent of the registry so a registry that declares less cannot quietly shrink its own expectation."
  );
}

for (const site of SITES) {
  const abs = path.join(root, site.file);
  if (!fs.existsSync(abs)) {
    problems.push("missing pin site: " + site.file + " (" + site.label + ")");
    continue;
  }
  // existsSync says the path resolves, not that it can be read: EACCES, EISDIR and EMFILE all land here, and the sibling read of package.json below is already guarded. Reported and skipped rather than thrown, so one unreadable site still leaves the other five, and their disagreement, in the output.
  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (err) {
    problems.push("could not read pin site " + site.file + " (" + site.label + "): " + errMsg(err));
    continue;
  }
  const found = [...content.matchAll(site.re)];
  if (found.length !== site.expect) {
    problems.push(
      site.file + ": expected " + site.expect + " " + site.label + " reading(s), found " + found.length +
      " — a pin site moved or changed shape; re-register it in this gate."
    );
  }
  for (const m of found) {
    readings.push({ where: site.file + ":" + lineOf(content, m.index), label: site.label, value: m[1] });
  }
}

// package.json: two exact pins plus the advisory engines floor.
let floor = null;
const pkgPath = path.join(root, "package.json");
if (!fs.existsSync(pkgPath)) {
  problems.push("missing pin site: package.json");
} else {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    problems.push("package.json is not parseable JSON: " + err.message);
    pkg = null;
  }
  if (pkg) {
    const pm = typeof pkg.packageManager === "string" ? /^bun@(.+)$/.exec(pkg.packageManager) : null;
    if (!pm) problems.push("package.json: packageManager is not a \"bun@<version>\" string");
    else readings.push({ where: "package.json", label: "packageManager", value: pm[1] });

    const types = pkg.devDependencies?.["@types/bun"];
    if (typeof types !== "string") problems.push("package.json: devDependencies[\"@types/bun\"] is missing");
    else if (!new RegExp("^" + SEMVER + "$").test(types)) {
      problems.push("package.json: @types/bun must be pinned exactly (got \"" + types + "\") — it describes the runtime API surface.");
    } else readings.push({ where: "package.json", label: "@types/bun", value: types });

    const eng = pkg.engines?.bun;
    const m = typeof eng === "string" ? /^>=([0-9]+\.[0-9]+)$/.exec(eng) : null;
    if (!m) problems.push("package.json: engines.bun must be a \">=<major>.<minor>\" floor (got " + JSON.stringify(eng) + ")");
    else floor = m[1];
  }
}

// The detector, and the only check with a view of what was actually COLLECTED: the per-site counts speak for rows still registered and pass a reading they counted but never pushed, and the declared sum above is a statement about the registry, not about the scan. A pin that stops reaching this array is invisible to both.
if (readings.length !== EXPECTED) {
  problems.push("expected " + EXPECTED + " Bun pin readings across the repo, collected " + readings.length + ".");
}

const distinct = [...new Set(readings.map((r) => r.value))];
if (distinct.length > 1) {
  const byVersion = new Map();
  for (const r of readings) {
    if (!byVersion.has(r.value)) byVersion.set(r.value, []);
    byVersion.get(r.value).push(r.where + " (" + r.label + ")");
  }
  const lines = [...byVersion.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([v, wheres]) => "  " + v + ":\n" + wheres.map((w) => "    " + w).join("\n"));
  problems.push("Bun pin skew — these sites disagree:\n" + lines.join("\n"));
}

// The floor is advisory (nothing enforces engines without engineStrict), but a
// floor below the pinned runtime documents a version the repo no longer runs.
if (floor !== null && distinct.length === 1) {
  const want = distinct[0].split(".").slice(0, 2).join(".");
  if (floor !== want) {
    problems.push("package.json: engines.bun floor is \">=" + floor + "\" but the pinned runtime is " + distinct[0] + " (expected \">=" + want + "\").");
  }
}

if (problems.length > 0) {
  console.error("no-bun-version-skew gate: FAILED");
  console.error(problems.map((p) => "  " + p).join("\n"));
  console.error("");
  console.error("Every Bun pin must move together. Renovate reaches every site except packageManager,");
  console.error("and does so through five separate managers, so a partial bump lands silently.");
  process.exit(1);
}

console.log("no-bun-version-skew gate: OK (" + readings.length + " pins agree at " + distinct[0] + ", engines floor >=" + floor + ")");
'
