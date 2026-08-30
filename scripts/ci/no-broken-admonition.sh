#!/usr/bin/env bash
# Catch Material admonitions whose first body line is flush-left.
#
# Material for MkDocs requires an admonition's body indented 4 spaces past the
# `!!!`/`???` marker. A first body line at the marker's own indent renders
# OUTSIDE the box — a silent visual break `mkdocs --strict` never catches
# because admonitions render client-side. This gate flags the exact signature:
# a non-blank line directly under a marker (no blank line between) whose indent
# is <= the marker's. Title-only admonitions (marker then a blank line) and
# correctly-indented bodies are left alone.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R/--include, so the
# scan uses bun's fs, not a recursive grep. A vacuity guard fails the gate if no
# docs are scanned.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-broken-admonition

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$root}"
cd "$root"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Walked and vacuity-checked by the shared helper: it refuses a walk that returns nothing AND one that still returns pages but no longer reaches docs/index.md, the docs home page, which carries admonitions of its own. The second stop is the one a page count cannot express — a docs re-layout leaves plenty of markdown in scope while the pages this rule was written for go unscanned.
const files = collectOrExit({
  root,
  label: "markdown files",
  skipDirs: ["node_modules"],
  test: (p) => p.endsWith(".md"),
  roots: [{ name: "docs", anchors: [path.join("docs", "index.md")] }],
});

const indent = (s) => (s.match(/^\s*/)[0] || "").length;
const marker = /^(\s*)(!!!|\?\?\?\+?)\s/;
const fence = /^\s*(```|~~~)/;
const hits = [];

for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    // Boolean toggle, not a length/char-aware fence parser: it does not model a
    // longer outer fence wrapping a shorter one (e.g. ```` wrapping ```). The
    // docs corpus uses only balanced ```/~~~ blocks, so this suffices; revisit
    // if nested fences appear.
    if (fence.test(lines[i])) { inFence = !inFence; continue; } // toggle code fence
    if (inFence) continue; // markers inside a fenced code block are literal text
    const m = marker.exec(lines[i]);
    if (!m) continue;
    const next = lines[i + 1];
    if (next.trim() === "") continue; // blank line = title-only or proper spacing
    if (marker.test(next)) continue; // stacked markers, not a body line
    if (indent(next) <= m[1].length) {
      hits.push(path.relative(root, file) + ":" + (i + 2) + ": " + next.trim());
    }
  }
}

if (hits.length > 0) {
  console.error("Admonition body line is flush-left (renders OUTSIDE the box):");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("Indent every admonition body line 4 spaces past its !!!/??? marker.");
  process.exit(1);
}

console.log("no-broken-admonition gate: OK (" + files.length + " docs scanned)");
'
