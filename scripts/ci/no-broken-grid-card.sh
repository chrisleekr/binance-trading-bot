#!/usr/bin/env bash
# Catch Material card grids whose item bodies are indented too shallowly.
#
# A `<div class="grid cards" markdown>` block is a Markdown list whose card body
# (the `---` divider and the description) is a 4-space continuation of the list
# item — the form Material documents in reference/grids.md. Python-Markdown reads
# a continuation only at the full tab_length, so at 2 spaces the body detaches
# and renders as a SIBLING of the list: every description falls outside its card
# and the grid staggers. `mkdocs --strict` cannot see it — the markup is valid,
# just semantically wrong — and prettier actively reintroduces it by normalising
# list continuation to 2 spaces, which is how this shipped broken once already.
#
# The `<!-- prettier-ignore-start -->` fence around each grid is what stops that;
# this gate is the backstop for the day someone drops the fence.
#
# Not modelled: a nested LIST inside a card. Checked against Python-Markdown —
# at the body indent it ends the item and becomes a sibling card, and one level
# deeper it becomes an indented code block, so there is no correct form for the
# gate to enforce. A deeper marker is treated as body content and skipped.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R/--include, so the
# scan uses bun's fs, not a recursive grep. A vacuity guard fails the gate if no
# docs are scanned.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-broken-grid-card

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

const OPEN = /^\s*<div[^>]*class="[^"]*\bgrid\b[^"]*\bcards\b[^"]*"[^>]*>/;
const DIV_OPEN = /^\s*<div\b/;
const CLOSE = /^\s*<\/div>/;
const ITEM = /^(\s*)([-*+])(\s+)\S/;
const FENCE = /^\s*(```|~~~)/;
// A tab is one indent level, so it has to be widened before any comparison —
// otherwise a legally tab-indented body measures as one column.
const width = (s) => (s.match(/^\s*/)[0] || "").replace(/\t/g, "    ").length;
const hits = [];
let grids = 0;

for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let inFence = false;
  let inGrid = false;
  let openedAtLine = 0;
  // Column the grid itself starts at. A grid can be nested inside a content tab
  // or an admonition, where its cards sit at 4+ columns; measuring against
  // absolute column 0 would leave every card in it unchecked.
  let gridIndent = 0;
  // Depth of plain <div>s opened INSIDE the grid, so a card that wraps its body
  // in its own div does not close the grid early and silently skip the rest.
  let innerDivs = 0;
  // Body lines belong to the card most recently opened; a card with only a
  // title has no body to check, which is the simple-grid form and is fine.
  let bodyIndentNeeded = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Same boolean toggle as no-broken-admonition.sh, and for the same reason:
    // a fenced block DEMONSTRATING this markup is literal text. Without it, a
    // page documenting card grids opens a phantom grid that never closes and
    // every list after it is measured as card body.
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!inGrid) {
      if (OPEN.test(line)) {
        inGrid = true; grids++; bodyIndentNeeded = 0; innerDivs = 0;
        gridIndent = width(line); openedAtLine = i + 1;
      }
      continue;
    }
    if (CLOSE.test(line)) {
      if (innerDivs > 0) innerDivs--;
      else inGrid = false;
      continue;
    }
    if (DIV_OPEN.test(line)) { innerDivs++; continue; }
    const m = ITEM.exec(line);
    if (m) {
      // Only a marker at the indent of the GRID itself opens a card. A deeper
      // one is a
      // nested list, i.e. body content: it must not raise the bar for the
      // remaining paragraphs of the parent card, which are still correct.
      // (No apostrophes in this block — the whole script body is a single-quoted
      // shell argument.)
      if (width(line) === gridIndent) bodyIndentNeeded = gridIndent + m[2].length + m[3].length;
      continue;
    }
    if (line.trim() === "" || bodyIndentNeeded === 0) continue;
    // Only a line that STARTS a block can detach from the item. A wrapped line
    // with no blank line above it is a lazy continuation, which Markdown folds
    // into the item at any indent, so flagging it would reject valid prose.
    if ((lines[i - 1] ?? "").trim() !== "") continue;
    const indent = width(line);
    const needed = Math.max(gridIndent + 4, bodyIndentNeeded);
    if (indent < needed) {
      hits.push(
        path.relative(root, file) + ":" + (i + 1) +
          ": indented " + indent + ", needs " + needed + " — " + line.trim(),
      );
    }
  }
  // An unclosed grid means everything after it was measured as card body, so the
  // hits above are unreliable — say so rather than let them read as real.
  if (inGrid) {
    hits.push(path.relative(root, file) + ":" + openedAtLine + ": card grid <div> is never closed");
  }
}

if (grids === 0) {
  console.log("no-broken-grid-card gate: OK (no card grids in " + files.length + " docs)");
  process.exit(0);
}

if (hits.length > 0) {
  console.error("Card-grid body line is under-indented (renders OUTSIDE the card):");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("Use `-   ` for the item and indent its body 4 spaces, and keep the");
  console.error("<!-- prettier-ignore-start --> fence — prettier reverts it otherwise.");
  process.exit(1);
}

console.log(
  "no-broken-grid-card gate: OK (" + grids + " card grid(s) in " + files.length + " docs scanned)",
);
'
