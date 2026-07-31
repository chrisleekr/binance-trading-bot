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

GUARD_ROOT="$GUARD_ROOT" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const mdFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") mdFiles(p, out);
    } else if (/\.md$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};

const files = mdFiles(path.join(root, "docs"));
if (files.length === 0) {
  console.error("no markdown files scanned under docs/ — scan-path regression in this gate.");
  process.exit(1);
}

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
