#!/usr/bin/env bash
# Guard the integrity of the docs screenshot set: that the manifest, the
# committed PNGs and the pages that embed them agree, and that every embed
# discloses its data is seeded.
#
# The screenshots are captured by `bun run docs:screenshots` and committed. That
# means three lists can drift apart, each silently:
#
#   1. A page embeds a PNG nobody captures  → broken image on the built site.
#   2. The manifest claims a PNG nobody committed → the refresh looks complete
#      while a page still points at nothing.
#   3. A committed PNG no page embeds and no capture writes → dead weight that
#      no refresh will ever update, so it rots at whatever the UI looked like
#      the day it landed.
#   4. A screenshot embedded with no caption disclosing that the data is seeded
#      → a reader takes fabricated balances, prices and P/L for a real account.
#
# This gate fails on all four. It does NOT check that a committed PNG matches
# what the UI renders today — PNG bytes are not reproducible across machines
# (Chromium build, font stack, rasteriser), so a regenerate-and-diff gate would
# be permanently red. Keeping the images current is a `bun run docs:screenshots`
# run at review time, not a CI comparison.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R/--include, so the
# scan uses bun's fs, not a recursive grep. A vacuity guard fails the gate if
# nothing is scanned, because a drift gate that passes vacuously is worse than
# none.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-screenshot

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
# Overridable so the self-test can drive this gate over fixture trees.
GUARD_ROOT="${GUARD_ROOT:-$root}"
cd "$root"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;
const SHOT_DIR = path.join(root, "docs/assets/screenshots");

// unanchored-walk: the committed PNG set is not a verdict, it is one of three sets this gate cross-references, and every way it can narrow already surfaces by name. A PNG the walk stops seeing is reported as a missing file under the page that embeds it, and one it should not have seen is reported as orphaned; there is no reading of this listing that produces a confident OK, which is the only failure an anchor exists to prevent. Anchoring it on a named PNG would instead swallow the promised-but-uncommitted branch, which is a case worth more than the stop.
const pngFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") pngFiles(p, out);
    } else if (e.name.endsWith(".png")) {
      out.push(p);
    }
  }
  return out;
};

const { SHOTS } = await import(path.join(root, "e2e/docs-screenshots.manifest.mjs"));
if (!Array.isArray(SHOTS) || SHOTS.length === 0) {
  console.error("capture manifest is empty — scan-path regression in this gate.");
  process.exit(1);
}

// Walked and vacuity-checked by the shared helper. The docs walk IS a verdict here — an embed this gate never reads is an embed it never checks — so it needs the stop a page count cannot give: a docs re-layout leaves plenty of markdown in scope while the pages carrying screenshots go unread, and every committed PNG then reports as orphaned or, worse, nothing reports at all.
const mdFiles = collectOrExit({
  root,
  label: "markdown files",
  skipDirs: ["node_modules"],
  test: (p) => p.endsWith(".md"),
  roots: [{ name: "docs", anchors: [path.join("docs", "index.md")] }],
});

// What the manifest promises to write, relative to docs/assets/screenshots.
const captured = new Set(SHOTS.flatMap((s) => s.dest));
// What is committed.
const committed = new Set(
  pngFiles(SHOT_DIR).map((p) => path.relative(SHOT_DIR, p).split(path.sep).join("/")),
);
// What the pages actually embed.
const embedded = new Map();
// Every screenshot ships fabricated data — seeded balances, prices and P/L. The
// caption under each image has to say so, or a reader reasonably reads the
// numbers as a real account. Checked on the two lines after the image so a
// caption cannot be satisfied by a disclosure elsewhere on the page.
const DISCLOSURE = /seeded (demo|sample) data/i;
const undisclosed = [];
for (const file of mdFiles) {
  const body = fs.readFileSync(file, "utf8");
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = /assets\/screenshots\/([A-Za-z0-9/_-]+\.png)/.exec(line);
    if (!m) continue;
    if (!embedded.has(m[1])) embedded.set(m[1], []);
    embedded.get(m[1]).push(path.relative(root, file));
    const caption = lines.slice(i + 1, i + 4).join(" ");
    if (!DISCLOSURE.test(caption)) {
      undisclosed.push(m[1] + "  (" + path.relative(root, file) + ":" + (i + 1) + ")");
    }
  }
}

const problems = [];
const list = (label, items) => {
  problems.push(label);
  for (const i of items) problems.push("  " + i);
};

const missingFile = [...embedded.keys()].filter((p) => !committed.has(p));
if (missingFile.length > 0) {
  list("Embedded by a docs page but not committed:", missingFile.map((p) => p + "  (" + embedded.get(p).join(", ") + ")"));
}

const uncaptured = [...embedded.keys()].filter((p) => committed.has(p) && !captured.has(p));
if (uncaptured.length > 0) {
  list("Embedded by a docs page but no capture writes it (it can never be refreshed):", uncaptured);
}

const promisedMissing = [...captured].filter((p) => !committed.has(p));
if (promisedMissing.length > 0) {
  list("Declared in the capture manifest but not committed:", promisedMissing);
}

const orphaned = [...committed].filter((p) => !embedded.has(p));
if (orphaned.length > 0) {
  list("Committed but embedded by no docs page:", orphaned);
}

if (undisclosed.length > 0) {
  list("Embedded without a caption saying the data is seeded:", undisclosed);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error("");
  console.error("Add the screen to e2e/docs-screenshots.manifest.mjs, embed it from a docs page,");
  console.error("then refresh the set with `bun run docs:screenshots` and commit the PNGs.");
  console.error("Every embed needs a caption within the next 3 lines containing");
  console.error("\"seeded demo data\" (or \"seeded sample data\").");
  process.exit(1);
}

console.log(
  "no-stale-screenshot gate: OK (" + committed.size + " screenshots, " +
  SHOTS.length + " captures, " + mdFiles.length + " docs scanned)",
);
'
