#!/usr/bin/env bash
# Structural lint for Mermaid diagrams in docs/.
#
# `mkdocs build --strict` proves a page renders and its links resolve; it does
# NOT parse Mermaid — mkdocs-mermaid2-plugin ships the source to the browser and
# mermaid.js renders it client-side, so a syntax error becomes a blank box the
# reader sees and CI never does. This gate closes that hole for the failure
# modes documented in the repo's Mermaid rules (.claude/rules/mermaid.md), which
# are exactly the ones that have bitten: they break GitHub's renderer or trip
# mermaid's parser.
#
# Scope: this is a structural scanner, not a full Mermaid parser (a real parse
# needs a DOM/browser, unavailable in the bun:alpine CI image). It catches the
# enumerated rule violations below with low false-positive risk; arbitrary
# grammar errors still fall to the client render as before.
#
# Checks, per ```mermaid fenced block under docs/:
#   1. literal "\n" in a label            → must use <br/> (mermaid renders \n literally)
#   2. `class Node Name` statement        → use inline :::className; separate `class` fails GitHub
#   3. label starting `<digit>.`          → parsed as an ordered list, breaks the parser
#   4. more than one `subgraph` per block → GitHub's renderer fails on a 2nd subgraph after `end`
#   5. `(` or `)` inside a "double-quoted" label → repo rule bans parens in labels
#
# Checks 3 and 5 scan inside "double-quoted" labels only — the form every diagram
# in docs/ uses. An unquoted-paren break (`A[foo (bar)]`) is not separately
# detected; it still falls to the client render.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs, not a recursive grep. A vacuity guard
# fails the gate rather than pass it if zero Mermaid blocks are scanned (scan-path
# regression), because a drift gate that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-invalid-mermaid

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
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

const hits = [];
let blockCount = 0;

for (const file of files) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  let inBlock = false;
  let blockStart = 0;
  let subgraphs = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);

    if (fence) {
      if (!inBlock && fence[1] === "mermaid") {
        inBlock = true;
        blockStart = i + 1;
        subgraphs = 0;
        blockCount++;
        continue;
      }
      if (inBlock) {
        // closing fence
        inBlock = false;
        continue;
      }
    }
    if (!inBlock) continue;

    const at = rel + ":" + (i + 1);

    // 1. literal backslash-n (not a <br/>)
    if (line.includes("\\n")) hits.push(at + ": literal newline escape in label — use <br/> instead");

    // 2. separate `class Node Name` statement (classDef is fine; a class-diagram
    //    member block `class Foo {` ends in a brace and is not this violation)
    if (/^\s*class\s+\S+\s+\S+/.test(line) && !/^\s*classDef\b/.test(line) && !/\{\s*$/.test(line))
      hits.push(at + ": separate `class` statement — use inline :::className");

    // 3. any "double-quoted" label whose text starts with <digit>.
    for (const m of line.matchAll(/"([^"]*)"/g)) {
      const label = m[1];
      if (/^\s*\d+\./.test(label))
        hits.push(at + ": label starts with a number-dot — parsed as an ordered list");
      // 5. parentheses inside a quoted label (banned by the repo Mermaid rule;
      //    quoted parens render but the rule forbids them — rename or drop)
      if (label.includes("(") || label.includes(")"))
        hits.push(at + ": parenthesis inside a label — banned by .claude/rules/mermaid.md");
    }

    // 4. count subgraphs within the block
    if (/^\s*subgraph\b/.test(line)) {
      subgraphs++;
      if (subgraphs === 2)
        hits.push(rel + ":" + blockStart + ": >1 subgraph in one diagram — GitHub renderer fails after the first `end`");
    }
  }
}

if (blockCount === 0) {
  console.error("no ```mermaid blocks found under docs/ — scan-path regression in this gate.");
  process.exit(1);
}

if (hits.length > 0) {
  console.error("Invalid Mermaid found (see .claude/rules/mermaid.md):");
  console.error(hits.map((h) => "  " + h).join("\n"));
  process.exit(1);
}

console.log("no-invalid-mermaid gate: OK (" + blockCount + " mermaid blocks in " + files.length + " docs scanned)");
'
